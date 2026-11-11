import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { convert } from 'html-to-text';
import type { EmailConnection, MailAccount, MailProvider, OutgoingMail, ReceivedMail, SendReceipt } from '../shared/email.js';
import { canonicalMailBody, outgoingMailHash } from './mail-content.js';

const API = 'https://api.agentmail.to/v0/';
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i;
const RFC_ID = /^<[^<>\s\u0000-\u001f]+@[^<>\s\u0000-\u001f]+>$/;
// The documented free-tier branding, verified against a real sent message.
// Accept only this exact additional suffix; never remove arbitrary trailing text.
const AGENTMAIL_FREE_FOOTER = '\n\n--\nSent via AgentMail';
type Json = Record<string, any>;
type Connection = { version: 1; clientId: string; inboxId?: string };
type Operation = { version: 1; inboxId: string; mail: OutgoingMail };
export type AgentMailOptions = {
  stateRoot?: string; transport?: typeof fetch; env?: () => NodeJS.ProcessEnv;
  now?: () => number; requestTimeoutMs?: number; maxBodyChars?: number;
};

export class MailProviderError extends Error {
  constructor(public readonly code: string, public readonly status: number | null = null, public readonly uncertain = false) {
    const messages: Record<string, string> = {
      mail_not_configured: 'Add AGENTMAIL_API_KEY to the local environment to connect email.',
      mail_not_connected: 'Connect a dedicated AgentMail inbox before using email outreach.',
      mail_account_changed: 'The connected inbox differs from the approved sender. Review the email again.',
      mail_inbox_inactive: 'This AgentMail inbox is deactivated.',
      mail_inbox_signature: 'Remove the inbox signature in AgentMail before sending reviewed messages.',
      mail_invalid_configuration: 'The AgentMail configuration is invalid.',
      mail_invalid_content: 'The email contains invalid recipients, headers, or threading information.',
      mail_content_changed: 'The email differs from its approved content. Review it again.',
      mail_draft_changed: 'The prepared email operation differs from the approved message.',
      mail_network: 'The email request could not be confirmed. Reconcile its status before trying again.',
      mail_response_invalid: 'AgentMail returned an unexpected response. Check the operation status.',
      mail_response_too_large: 'The email response exceeds the supported size.',
      mail_http: 'AgentMail rejected the request. Check access and operation status.',
      mail_storage: 'The email connection or operation could not be saved or read locally.',
      mail_reconcile_conflict: 'A sent message matches this operation but its contents differ. Review the conversation.',
      mail_duplicate_matches: 'Multiple sent messages match this operation. Review the conversation.',
      mail_oauth_unsupported: 'AgentMail uses an API key and dedicated inbox; OAuth is not required.',
    };
    super(messages[code] ?? 'The email operation could not be completed.'); this.name = 'MailProviderError';
    if (status === null && ['mail_not_configured', 'mail_not_connected'].includes(code)) this.status = 428;
    else if (status === null && ['mail_account_changed', 'mail_content_changed', 'mail_draft_changed', 'mail_inbox_inactive', 'mail_inbox_signature'].includes(code)) this.status = 409;
    else if (status === null && ['mail_invalid_configuration', 'mail_invalid_content'].includes(code)) this.status = 422;
  }
}
function obj(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
function stringId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1000 || /[\u0000-\u0020\u007f]/.test(value)) throw new MailProviderError('mail_response_invalid');
  return value;
}
function header(value: unknown, max = 1000): string {
  if (typeof value !== 'string' || value.length > max || /[\r\n\0]/.test(value)) throw new MailProviderError('mail_invalid_content');
  return value;
}
function email(value: string): string {
  header(value, 254); if (!EMAIL.test(value)) throw new MailProviderError('mail_invalid_content'); return value.toLowerCase();
}
function address(value: unknown): MailAccount | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
  const candidate = match ? match[2] : value.trim();
  if (!EMAIL.test(candidate)) return null;
  return { email: candidate.toLowerCase(), name: match ? match[1].replace(/^"(.*)"$/, '$1').replace(/\\(["\\])/g, '$1') : '' };
}
function headerOf(raw: Json, name: string): string {
  const entries = Object.entries(obj(raw.headers)).filter(([key]) => key.toLowerCase() === name.toLowerCase());
  return entries.length === 1 && typeof entries[0][1] === 'string' ? entries[0][1] : '';
}
function referenceIds(raw: Json): string[] {
  if (Array.isArray(raw.references)) return raw.references.filter((v: unknown): v is string => typeof v === 'string');
  return headerOf(raw, 'References').match(/<[^<>\s]+>/g) ?? [];
}
function received(raw: Json, maxBodyChars: number, extracted = true): ReceivedMail {
  const sender = address(raw.from), recipients = Array.isArray(raw.to) ? raw.to.map(address) : [];
  if (!sender || recipients.some((a: MailAccount | null) => !a) || !Number.isFinite(Date.parse(raw.timestamp))) throw new MailProviderError('mail_response_invalid');
  let body = '', truncated = raw.truncated === true;
  const text = extracted && typeof raw.extracted_text === 'string' && raw.extracted_text.trim() ? raw.extracted_text : raw.text;
  if (typeof text === 'string') body = text;
  else {
    const html = extracted && typeof raw.extracted_html === 'string' && raw.extracted_html.trim() ? raw.extracted_html : raw.html;
    if (typeof html === 'string') {
      const cap = Math.max(maxBodyChars * 8, 100_000);
      if (html.length > cap) truncated = true;
      body = convert(html.slice(0, cap), { wordwrap: false, selectors: [{ selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' }], limits: { maxInputLength: cap } });
    }
  }
  body = canonicalMailBody(body);
  if (body.length > maxBodyChars) { body = body.slice(0, maxBodyChars); truncated = true; }
  const automatic = headerOf(raw, 'Auto-Submitted').trim().toLowerCase();
  const rawId = stringId(raw.message_id), inReplyTo = typeof raw.in_reply_to === 'string' ? raw.in_reply_to : (headerOf(raw, 'In-Reply-To').match(/<[^<>\s]+>/)?.[0] ?? null);
  return { id: rawId, threadId: stringId(raw.thread_id), rfcMessageId: headerOf(raw, 'Message-ID') || rawId,
    from: sender.email, to: recipients.map((a: MailAccount | null) => a!.email), subject: typeof raw.subject === 'string' ? raw.subject : '', body,
    receivedAt: new Date(raw.timestamp).toISOString(), inReplyTo, references: referenceIds(raw), autoSubmitted: !!automatic && automatic !== 'no', truncated,
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : []).map((a: Json) => ({ filename: typeof a.filename === 'string' ? a.filename.slice(0, 500) : '', mimeType: typeof a.content_type === 'string' ? a.content_type.slice(0, 200) : 'application/octet-stream' })), raw };
}
function validateMail(mail: OutgoingMail): void {
  email(mail.from.email); email(mail.to); header(mail.from.name, 200); header(mail.subject, 800); header(mail.rfcMessageId, 254);
  if (!mail.subject.trim() || !RFC_ID.test(mail.rfcMessageId) || typeof mail.body !== 'string' || mail.body.length > 200_000 || mail.body.includes('\0') || !Array.isArray(mail.references) || mail.references.length > 100) throw new MailProviderError('mail_invalid_content');
  for (const reference of [...mail.references, ...(mail.inReplyTo ? [mail.inReplyTo] : [])]) if (!RFC_ID.test(header(reference, 1000))) throw new MailProviderError('mail_invalid_content');
  if (mail.threadId && (!mail.inReplyTo || !mail.references.includes(mail.inReplyTo))) throw new MailProviderError('mail_invalid_content');
  if (mail.threadId) stringId(mail.threadId);
  if (!/^[a-f0-9]{64}$/.test(mail.contentHash) || outgoingMailHash(mail) !== mail.contentHash) throw new MailProviderError('mail_content_changed');
}
function operationKey(mail: OutgoingMail): string {
  return 'sourcing-' + createHash('sha256').update(JSON.stringify([mail.from.email.toLowerCase(), mail.rfcMessageId, mail.contentHash])).digest('hex');
}

/** Archil remains the approval journal; this adapter stores connection and immutable prepared operations locally. */
export class AgentMailProvider implements MailProvider {
  private readonly transport: typeof fetch;
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly root: string;
  private readonly timeoutMs: number;
  private readonly maxBodyChars: number;
  private connecting: Promise<MailAccount> | null = null;
  private cached: { key: string; inboxId: string; account: MailAccount; at: number } | null = null;

  constructor(options: AgentMailOptions = {}) {
    this.transport = options.transport ?? fetch; this.env = options.env ?? (() => process.env); this.now = options.now ?? Date.now;
    this.root = resolve(options.stateRoot ?? 'work/auth'); this.timeoutMs = options.requestTimeoutMs ?? 20_000; this.maxBodyChars = options.maxBodyChars ?? 50_000;
  }
  private key(): string {
    const key = this.env().AGENTMAIL_API_KEY;
    if (!key) throw new MailProviderError('mail_not_configured');
    if (key.length > 4000 || /[\s\0]/.test(key)) throw new MailProviderError('mail_invalid_configuration');
    return key;
  }
  private async connection(): Promise<Connection | null> {
    try {
      const value = obj(JSON.parse(await readFile(join(this.root, 'agentmail.json'), 'utf8')));
      if (value.version !== 1 || typeof value.clientId !== 'string' || !/^[a-z0-9._~-]{1,256}$/i.test(value.clientId) || (value.inboxId !== undefined && typeof value.inboxId !== 'string')) throw new Error();
      if (value.inboxId) stringId(value.inboxId);
      return value as Connection;
    } catch (error: any) { if (error?.code === 'ENOENT') return null; throw new MailProviderError('mail_storage'); }
  }
  private async inboxId(): Promise<string> {
    const configured = this.env().AGENTMAIL_INBOX_ID;
    if (configured) return stringId(configured);
    const saved = await this.connection();
    if (!saved?.inboxId) throw new MailProviderError('mail_not_connected');
    return saved.inboxId;
  }
  private async save(path: string, value: unknown, immutable = false): Promise<void> {
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      if (immutable) {
        try {
          await link(temporary, path);
        } catch (error: any) {
          if (error?.code !== 'EEXIST') throw error;
          if (JSON.stringify(JSON.parse(await readFile(path, 'utf8'))) !== JSON.stringify(value)) throw new MailProviderError('mail_draft_changed');
        }
        await unlink(temporary); return;
      }
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      if (error instanceof MailProviderError) throw error;
      throw new MailProviderError('mail_storage');
    }
  }
  private async request(path: string, method = 'GET', body?: Json, mutation = false, idempotencyKey?: string): Promise<Json> {
    const key = this.key(); let response: Response;
    try {
      response = await this.transport(API + path, { method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new MailProviderError('mail_network', null, mutation); }
    if (!response.ok) throw new MailProviderError('mail_http', response.status, mutation && (response.status >= 500 || [408, 409, 429].includes(response.status)));
    try {
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      if (reader) while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new MailProviderError('mail_response_too_large', response.status, mutation); }
        chunks.push(part.value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch (error) {
      if (error instanceof MailProviderError) throw error;
      throw new MailProviderError('mail_response_invalid', response.status, mutation);
    }
  }
  private async verifiedAccount(force = false, requestedInboxId?: string): Promise<MailAccount> {
    const key = this.key(), inboxId = requestedInboxId ?? await this.inboxId();
    if (!force && this.cached?.key === key && this.cached.inboxId === inboxId && this.now() - this.cached.at < 15_000) return { ...this.cached.account };
    const inbox = await this.request(`inboxes/${encodeURIComponent(inboxId)}`);
    if (inbox.inbox_id !== inboxId) throw new MailProviderError('mail_response_invalid');
    if (inbox.status === 'deactivated') throw new MailProviderError('mail_inbox_inactive');
    if (obj(inbox.signature).text || obj(inbox.signature).html) throw new MailProviderError('mail_inbox_signature');
    const account = { email: email(inbox.email ?? ''), name: typeof inbox.display_name === 'string' && inbox.display_name ? header(inbox.display_name, 200) : 'AgentMail' };
    this.cached = { key, inboxId, account, at: this.now() }; return { ...account };
  }
  async status(): Promise<EmailConnection> {
    if (!this.env().AGENTMAIL_API_KEY) return { configured: false, connected: false, account: null, state: 'disconnected', error: null };
    try { const account = await this.verifiedAccount(); return { configured: true, connected: true, account, state: 'connected', error: null }; }
    catch (error) {
      if (error instanceof MailProviderError && error.code === 'mail_not_connected') return { configured: true, connected: false, account: null, state: this.connecting ? 'connecting' : 'disconnected', error: null };
      return { configured: true, connected: false, account: null, state: 'error', error: error instanceof MailProviderError ? error.message : 'Could not verify the email connection.' };
    }
  }
  async account(): Promise<MailAccount> { return this.verifiedAccount(); }
  /** Called only by the user's explicit Connect Inbox action. Never called by status/startup. */
  async connectInbox(): Promise<MailAccount> {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      this.key(); const saved = await this.connection();
      if (this.env().AGENTMAIL_INBOX_ID || saved?.inboxId) return this.verifiedAccount(true);
      const connection: Connection = saved ?? { version: 1, clientId: `sourcing-inbox-${randomUUID()}` };
      if (!saved) await this.save(join(this.root, 'agentmail.json'), connection);
      const name = this.env().EMAIL_SENDER_NAME?.trim() || 'Procurement team'; header(name, 200);
      const created = await this.request('inboxes', 'POST', { client_id: connection.clientId, display_name: name }, true);
      let inboxId: string;
      try { inboxId = stringId(created.inbox_id); } catch { throw new MailProviderError('mail_response_invalid', 200, true); }
      await this.save(join(this.root, 'agentmail.json'), { ...connection, inboxId });
      return this.verifiedAccount(true);
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  private async checkOutgoing(mail: OutgoingMail): Promise<string> {
    validateMail(mail);
    const inboxId = await this.inboxId(), account = await this.verifiedAccount(true, inboxId);
    if (account.email !== mail.from.email.toLowerCase() || account.name !== mail.from.name) throw new MailProviderError('mail_account_changed');
    return inboxId;
  }
  async createDraft(mail: OutgoingMail): Promise<{ draftId: string }> {
    const inboxId = await this.checkOutgoing(mail), draftId = operationKey(mail);
    const operation: Operation = { version: 1, inboxId, mail: structuredClone(mail) };
    await this.save(join(this.root, `${draftId}.json`), operation, true);
    return { draftId };
  }
  async sendDraft(draftId: string, mail: OutgoingMail): Promise<SendReceipt> {
    const inboxId = await this.checkOutgoing(mail), expected = operationKey(mail);
    if (draftId !== expected) throw new MailProviderError('mail_draft_changed');
    let operation: Operation;
    try { operation = JSON.parse(await readFile(join(this.root, `${expected}.json`), 'utf8')); } catch { throw new MailProviderError('mail_storage'); }
    if (operation.version !== 1 || operation.inboxId !== inboxId || JSON.stringify(operation.mail) !== JSON.stringify(mail)) throw new MailProviderError('mail_draft_changed');
    const headers: Record<string, string> = { 'X-Sourcing-Operation-Id': mail.rfcMessageId, 'X-Sourcing-Content-Hash': mail.contentHash,
      ...(mail.inReplyTo ? { 'In-Reply-To': mail.inReplyTo } : {}), ...(mail.references.length ? { References: mail.references.join(' ') } : {}) };
    const body = { to: [mail.to], subject: mail.subject, text: canonicalMailBody(mail.body), headers, labels: [expected], track_opens: false };
    const result = await this.request(`inboxes/${encodeURIComponent(inboxId)}/messages/send`, 'POST', body, true, expected);
    try {
      const receipt = { messageId: stringId(result.message_id), threadId: stringId(result.thread_id) };
      // AgentMail can assign a new internal thread even when the supplied RFC
      // reply headers keep the recipient's conversation intact. Track its ID.
      return receipt;
    } catch { throw new MailProviderError('mail_response_invalid', 200, true); }
  }
  async listThreadMessages(threadId: string): Promise<{ id: string; threadId: string }[]> {
    stringId(threadId); const inboxId = await this.inboxId(), found = new Map<string, { id: string; threadId: string; timestamp: string }>();
    let pageToken: string | undefined;
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ limit: '100', ...(pageToken ? { page_token: pageToken } : {}) });
      const result = await this.request(`inboxes/${encodeURIComponent(inboxId)}/threads/${encodeURIComponent(threadId)}?${query}`);
      if (result.inbox_id !== inboxId || result.thread_id !== threadId || !Array.isArray(result.messages)) throw new MailProviderError('mail_response_invalid');
      for (const message of result.messages) {
        const item = { id: stringId(message.message_id), threadId: stringId(message.thread_id), timestamp: message.timestamp };
        if (item.threadId !== threadId || !Number.isFinite(Date.parse(item.timestamp))) throw new MailProviderError('mail_response_invalid');
        found.set(item.id, item);
      }
      pageToken = typeof result.next_page_token === 'string' && result.next_page_token ? result.next_page_token : undefined;
      if (!pageToken) return [...found.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id)).map(({ id, threadId }) => ({ id, threadId }));
    }
    throw new MailProviderError('mail_response_too_large');
  }
  async readMessage(messageId: string): Promise<ReceivedMail> {
    const raw = await this.readRaw(messageId); return received(raw, this.maxBodyChars);
  }
  private async readRaw(messageId: string): Promise<Json> {
    stringId(messageId); const inboxId = await this.inboxId();
    const raw = await this.request(`inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`);
    if (raw.inbox_id !== inboxId || raw.message_id !== messageId) throw new MailProviderError('mail_response_invalid');
    return raw;
  }
  async reconcileSent(mail: OutgoingMail): Promise<SendReceipt | null> {
    const inboxId = await this.checkOutgoing(mail), label = operationKey(mail), matches: SendReceipt[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ labels: label, limit: '100', include_trash: 'true', ...(pageToken ? { page_token: pageToken } : {}) });
      const result = await this.request(`inboxes/${encodeURIComponent(inboxId)}/messages?${query}`);
      if (!Array.isArray(result.messages)) throw new MailProviderError('mail_response_invalid');
      for (const item of result.messages) {
        const raw = await this.readRaw(stringId(item.message_id)), message = received(raw, this.maxBodyChars, false), sender = address(raw.from);
        if (!Array.isArray(raw.labels) || !raw.labels.includes('sent')) continue;
        const approvedBody = canonicalMailBody(mail.body);
        const body = message.body === approvedBody + AGENTMAIL_FREE_FOOTER ? approvedBody : message.body;
        const actual: OutgoingMail = { ...mail, from: sender!, to: message.to[0] ?? '', subject: message.subject, body, inReplyTo: message.inReplyTo, references: message.references };
        if (headerOf(raw, 'X-Sourcing-Operation-Id') !== mail.rfcMessageId || headerOf(raw, 'X-Sourcing-Content-Hash') !== mail.contentHash || message.truncated || !sender || message.to.length !== 1 || message.attachments.length || (Array.isArray(raw.cc) && raw.cc.length) || (Array.isArray(raw.bcc) && raw.bcc.length) || outgoingMailHash(actual) !== mail.contentHash) throw new MailProviderError('mail_reconcile_conflict', null, true);
        if (mail.threadId && message.threadId !== mail.threadId) {
          // A new provider thread is allowed only after proving the exact
          // approved In-Reply-To still points into the original tracked thread.
          if (!mail.inReplyTo) throw new MailProviderError('mail_reconcile_conflict', null, true);
          const parent = await this.readRaw(mail.inReplyTo);
          if (parent.thread_id !== mail.threadId) throw new MailProviderError('mail_reconcile_conflict', null, true);
        }
        matches.push({ messageId: message.id, threadId: message.threadId });
      }
      pageToken = typeof result.next_page_token === 'string' && result.next_page_token ? result.next_page_token : undefined;
      if (!pageToken) break;
      if (page === 99) throw new MailProviderError('mail_response_too_large');
    }
    const unique = [...new Map(matches.map(match => [match.messageId, match])).values()];
    if (unique.length > 1) throw new MailProviderError('mail_duplicate_matches', null, true);
    return unique[0] ?? null;
  }
}
