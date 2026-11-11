import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMailProvider, MailProviderError } from '../server/agentmail.js';
import { outgoingMailHash } from '../server/mail-content.js';
import type { OutgoingMail } from '../shared/email.js';

type Call = { url: URL; method: string; headers: Headers; body: any };
const inboxId = 'inbox-123', inboxEmail = 'buyer@agentmail.to', name = 'Procurement team';
const inbox = { inbox_id: inboxId, email: inboxEmail, display_name: name };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function mail(overrides: Partial<OutgoingMail> = {}): OutgoingMail {
  const value = { from: { email: inboxEmail, name }, to: 'sales@example.cn', subject: 'RFQ: ISO 4762 — 询价', body: 'Please quote 10,000 screws.\n请提供报价。', rfcMessageId: '<op-123@sourcing.local>', threadId: null, inReplyTo: null, references: [], contentHash: '', ...overrides };
  value.contentHash = outgoingMailHash(value); return value;
}
async function harness(handler?: (call: Call) => Promise<Response> | Response, providedEnv?: NodeJS.ProcessEnv) {
  const root = await mkdtemp(join(tmpdir(), 'sourcing-agentmail-'));
  const calls: Call[] = [];
  const env = providedEnv ?? { AGENTMAIL_API_KEY: 'am_test_sentinel', AGENTMAIL_INBOX_ID: inboxId };
  const transport: typeof fetch = async (url, init) => {
    const call = { url: new URL(String(url)), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    assert.equal(call.headers.get('Authorization'), `Bearer ${env.AGENTMAIL_API_KEY}`);
    if (handler) return handler(call);
    if (call.method === 'GET' && call.url.pathname === `/v0/inboxes/${inboxId}`) return response(inbox);
    throw new Error('Unexpected test request');
  };
  const options = { stateRoot: root, transport, env: () => env };
  return { root, env, calls, options, provider: new AgentMailProvider(options), async cleanup() { await rm(root, { recursive: true, force: true }); } };
}
function sentRaw(outgoing: OutgoingMail, messageId = '<sent@agentmail.to>') {
  return { inbox_id: inboxId, thread_id: outgoing.threadId ?? 'thread-123', message_id: messageId, from: `${outgoing.from.name} <${outgoing.from.email}>`, to: [outgoing.to], subject: outgoing.subject, text: outgoing.body,
    extracted_text: 'Provider extraction may omit content; never use it to verify a send.',
    timestamp: '2026-11-11T01:02:03Z', labels: ['sent'], headers: { 'X-Sourcing-Operation-Id': outgoing.rfcMessageId, 'X-Sourcing-Content-Hash': outgoing.contentHash, 'Message-ID': messageId },
    in_reply_to: outgoing.inReplyTo ?? undefined, references: outgoing.references };
}

test('missing configuration is safe and status never provisions an inbox; explicit connect is idempotent and stores no key', async () => {
  let creates = 0;
  const h = await harness(call => {
    if (call.method === 'POST') { creates++; assert.equal(call.url.pathname, '/v0/inboxes'); assert.match(call.body.client_id, /^sourcing-inbox-/); assert.equal(call.body.display_name, name); return response(inbox); }
    return response(inbox);
  }, {});
  try {
    assert.deepEqual(await h.provider.status(), { configured: false, connected: false, account: null, state: 'disconnected', error: null });
    assert.equal(h.calls.length, 0);
    await assert.rejects(h.provider.connectInbox(), error => error instanceof MailProviderError && error.status === 428);
    h.env.AGENTMAIL_API_KEY = 'am_connect_secret';
    assert.equal((await h.provider.status()).connected, false);
    assert.equal(h.calls.length, 0);
    const [one, two] = await Promise.all([h.provider.connectInbox(), h.provider.connectInbox()]);
    assert.deepEqual(one, { email: inboxEmail, name }); assert.deepEqual(two, one); assert.equal(creates, 1);
    const saved = await readFile(join(h.root, 'agentmail.json'), 'utf8');
    assert.ok(!saved.includes(h.env.AGENTMAIL_API_KEY)); assert.equal((await stat(join(h.root, 'agentmail.json'))).mode & 0o777, 0o600);
    const restarted = new AgentMailProvider(h.options); await restarted.connectInbox(); assert.equal(creates, 1);
    assert.ok(!JSON.stringify(await restarted.status()).includes(h.env.AGENTMAIL_API_KEY));
    h.env.AGENTMAIL_API_KEY = 'am_rotated_secret'; await restarted.account();
    assert.equal(h.calls.at(-1)?.headers.get('Authorization'), 'Bearer am_rotated_secret');
  } finally { await h.cleanup(); }
});

test('uncertain inbox creation keeps its client_id for the next explicit connect and does not retry automatically', async () => {
  const clientIds: string[] = [];
  const h = await harness(call => {
    if (call.method === 'POST') {
      clientIds.push(call.body.client_id);
      if (clientIds.length === 1) throw new Error('am_secret must not escape');
      return response(inbox);
    }
    return response(inbox);
  }, { AGENTMAIL_API_KEY: 'am_secret' });
  try {
    await assert.rejects(h.provider.connectInbox(), error => error instanceof MailProviderError && error.uncertain && !String(error).includes('am_secret'));
    assert.equal(clientIds.length, 1);
    await new AgentMailProvider(h.options).connectInbox();
    assert.equal(clientIds.length, 2); assert.equal(clientIds[0], clientIds[1]);
  } finally { await h.cleanup(); }
});

test('reviewed local drafts send exact approved Unicode content and threading with deterministic idempotency', async () => {
  const h = await harness(call => {
    if (call.method === 'GET') return response(inbox);
    assert.equal(call.url.pathname, `/v0/inboxes/${inboxId}/messages/send`);
    return response({ message_id: '<sent@agentmail.to>', thread_id: 'thread-123' });
  });
  try {
    const outgoing = mail({ threadId: 'thread-123', inReplyTo: '<supplier@example.cn>', references: ['<initial@agentmail.to>', '<supplier@example.cn>'] });
    const prepared = await h.provider.createDraft(outgoing);
    assert.equal(h.calls.filter(c => c.method !== 'GET').length, 0, 'preparing a reviewed draft must not create mutable provider drafts');
    assert.equal((await stat(join(h.root, `${prepared.draftId}.json`))).mode & 0o777, 0o600);
    const restarted = new AgentMailProvider(h.options);
    const receipt = await restarted.sendDraft(prepared.draftId, outgoing);
    assert.deepEqual(receipt, { messageId: '<sent@agentmail.to>', threadId: 'thread-123' });
    const sent = h.calls.find(c => c.method === 'POST')!;
    assert.deepEqual(sent.body.to, [outgoing.to]); assert.equal(sent.body.subject, outgoing.subject); assert.equal(sent.body.text, outgoing.body);
    assert.equal(sent.body.html, undefined); assert.equal(sent.body.track_opens, false);
    assert.equal(sent.body.headers['In-Reply-To'], outgoing.inReplyTo); assert.equal(sent.body.headers.References, outgoing.references.join(' '));
    assert.equal(sent.body.headers['X-Sourcing-Content-Hash'], outgoing.contentHash);
    assert.equal(sent.headers.get('Idempotency-Key'), prepared.draftId);
    assert.ok(!JSON.stringify(sent.body).includes('am_test_sentinel'));
    const before = h.calls.length;
    await assert.rejects(restarted.sendDraft(prepared.draftId, { ...outgoing, body: 'Unreviewed change' }), error => error instanceof MailProviderError && error.code === 'mail_content_changed');
    assert.equal(h.calls.length, before, 'reject changed approval before even fetching account');
    await assert.rejects(restarted.createDraft(mail({ to: 'sales@example.cn\r\nBcc: thief@example.com' })), error => error instanceof MailProviderError && error.code === 'mail_invalid_content');
    assert.equal(h.calls.length, before);
  } finally { await h.cleanup(); }
});

test('ambiguous send returns a sanitized uncertain error after one POST and never resends', async () => {
  let mode: 'network' | 'http' | 'invalid' = 'network';
  const h = await harness(call => {
    if (call.method === 'GET') return response(inbox);
    if (mode === 'network') throw new Error('Authorization Bearer am_test_sentinel');
    if (mode === 'http') return response({ message: 'am_test_sentinel' }, 503);
    return response({ token: 'am_test_sentinel' });
  });
  try {
    const outgoing = mail(), prepared = await h.provider.createDraft(outgoing);
    for (const next of ['network', 'http', 'invalid'] as const) {
      mode = next; const before = h.calls.filter(c => c.method === 'POST').length;
      await assert.rejects(h.provider.sendDraft(prepared.draftId, outgoing), error => error instanceof MailProviderError && error.uncertain && !String(error).includes('am_test_sentinel'));
      assert.equal(h.calls.filter(c => c.method === 'POST').length - before, 1);
    }
  } finally { await h.cleanup(); }
});

test('sender changes and inbox signatures block sends before a mutation', async () => {
  let current = { ...inbox } as Record<string, unknown>;
  const h = await harness(() => response(current));
  try {
    const outgoing = mail(), prepared = await h.provider.createDraft(outgoing);
    current = { ...inbox, display_name: 'Other sender' };
    await assert.rejects(h.provider.sendDraft(prepared.draftId, outgoing), error => error instanceof MailProviderError && error.code === 'mail_account_changed');
    current = { ...inbox, signature: { text: 'An unreviewed signature' } };
    await assert.rejects(h.provider.sendDraft(prepared.draftId, outgoing), error => error instanceof MailProviderError && error.code === 'mail_inbox_signature');
    assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
  } finally { await h.cleanup(); }
});

test('thread polling follows older pages and returns chronological unique message IDs', async () => {
  const h = await harness(call => {
    assert.equal(call.method, 'GET'); assert.equal(call.url.pathname, `/v0/inboxes/${inboxId}/threads/thread-123`);
    const older = call.url.searchParams.has('page_token');
    return response({ inbox_id: inboxId, thread_id: 'thread-123', messages: [{ message_id: older ? '<old@example.cn>' : '<new@example.cn>', thread_id: 'thread-123', timestamp: older ? '2026-11-10T01:02:03Z' : '2026-11-11T01:02:03Z' }], ...(older ? {} : { next_page_token: 'older-page' }) });
  });
  try {
    assert.deepEqual(await h.provider.listThreadMessages('thread-123'), [{ id: '<old@example.cn>', threadId: 'thread-123' }, { id: '<new@example.cn>', threadId: 'thread-123' }]);
    assert.equal(h.calls.length, 2); assert.equal(h.calls[1].url.searchParams.get('page_token'), 'older-page');
  } finally { await h.cleanup(); }
});

test('inbound uses extracted plain text, preserves raw evidence/attachments and detects automatic mail; HTML fallback is bounded', async () => {
  const messageId = '<supplier/quoted+id@example.cn>';
  let raw: Record<string, any> = { inbox_id: inboxId, thread_id: 'thread-123', message_id: messageId, from: 'Manufacturer <sales@example.cn>', to: [`Buyer <${inboxEmail}>`], timestamp: '2026-11-11T01:02:03Z', subject: 'Quote', text: 'New quote\nOld quoted thread', extracted_text: 'New quote', headers: { 'Auto-Submitted': 'auto-replied' }, attachments: [{ filename: 'quote.pdf', content_type: 'application/pdf' }] };
  const h = await harness(call => { assert.equal(call.url.pathname, `/v0/inboxes/${inboxId}/messages/${encodeURIComponent(messageId)}`); return response(raw); });
  try {
    const parsed = await h.provider.readMessage(messageId);
    assert.equal(parsed.from, 'sales@example.cn'); assert.equal(parsed.body, 'New quote'); assert.equal(parsed.autoSubmitted, true);
    assert.deepEqual(parsed.to, [inboxEmail]); assert.equal(parsed.rfcMessageId, messageId); assert.deepEqual(parsed.raw, raw);
    assert.deepEqual(parsed.attachments, [{ filename: 'quote.pdf', mimeType: 'application/pdf' }]);
    raw = { ...raw, text: undefined, extracted_text: undefined, html: '<p>Hello <b>世界</b></p><script>ignore</script><p>' + 'x'.repeat(1000) + '</p>', headers: { 'Auto-Submitted': 'no' } };
    const limited = await new AgentMailProvider({ ...h.options, maxBodyChars: 40 }).readMessage(messageId);
    assert.equal(limited.truncated, true); assert.equal(limited.body.length, 40); assert.ok(limited.body.startsWith('Hello 世界')); assert.ok(!limited.body.includes('ignore')); assert.equal(limited.autoSubmitted, false);
  } finally { await h.cleanup(); }
});

test('reconciliation is read-only, verifies actual full sent content, and exposes conflicts rather than guessing success', async () => {
  const outgoing = mail();
  let items: string[] = ['<sent@agentmail.to>'], changed = false;
  const h = await harness(call => {
    assert.equal(call.method, 'GET');
    if (call.url.pathname === `/v0/inboxes/${inboxId}`) return response(inbox);
    if (call.url.pathname === `/v0/inboxes/${inboxId}/messages`) {
      assert.match(call.url.searchParams.get('labels') ?? '', /^sourcing-[a-f0-9]{64}$/);
      return response({ messages: items.map(message_id => ({ message_id })) });
    }
    const raw = sentRaw(outgoing, decodeURIComponent(call.url.pathname.split('/').at(-1)!));
    if (changed) raw.text = 'A different quote';
    return response(raw);
  });
  try {
    assert.deepEqual(await h.provider.reconcileSent(outgoing), { messageId: '<sent@agentmail.to>', threadId: 'thread-123' });
    changed = true;
    await assert.rejects(h.provider.reconcileSent(outgoing), error => error instanceof MailProviderError && error.code === 'mail_reconcile_conflict' && error.uncertain);
    changed = false; items = [];
    assert.equal(await h.provider.reconcileSent(outgoing), null);
    items = ['<sent@agentmail.to>', '<duplicate@agentmail.to>'];
    await assert.rejects(h.provider.reconcileSent(outgoing), error => error instanceof MailProviderError && error.code === 'mail_duplicate_matches');
    assert.equal((await readdir(h.root)).length, 0, 'read-only reconciliation does not save new drafts or send intent');
  } finally { await h.cleanup(); }
});

test('sent reconciliation permits only the exact single provider footer and rejects changed content or headers', async () => {
  const outgoing = mail(), footer = '\n\n--\nSent via AgentMail';
  let body = outgoing.body + footer, operationHeader = outgoing.rfcMessageId;
  const h = await harness(call => {
    assert.equal(call.method, 'GET');
    if (call.url.pathname === `/v0/inboxes/${inboxId}`) return response(inbox);
    if (call.url.pathname === `/v0/inboxes/${inboxId}/messages`) return response({ messages: [{ message_id: '<sent@agentmail.to>' }] });
    const raw = sentRaw(outgoing); raw.text = body; raw.headers['X-Sourcing-Operation-Id'] = operationHeader; return response(raw);
  });
  try {
    assert.ok(await h.provider.reconcileSent(outgoing));
    for (const changed of [outgoing.body.replace('10,000', '20,000') + footer, outgoing.body + footer + footer, outgoing.body + '\n\n--\n Sent via AgentMail', outgoing.body + '\nExtra unapproved terms' + footer]) {
      body = changed;
      await assert.rejects(h.provider.reconcileSent(outgoing), error => error instanceof MailProviderError && error.code === 'mail_reconcile_conflict');
    }
    body = outgoing.body + footer; operationHeader = '<different-operation@sourcing.local>';
    await assert.rejects(h.provider.reconcileSent(outgoing), error => error instanceof MailProviderError && error.code === 'mail_reconcile_conflict');
  } finally { await h.cleanup(); }
});

test('provider-assigned reply threads reconcile only with exact content and a verified parent in the original thread', async () => {
  const outgoing = mail({ threadId: 'original-thread', inReplyTo: '<supplier@example.cn>', references: ['<initial@agentmail.to>', '<supplier@example.cn>'] });
  let parentThread = 'original-thread', wrongReferences = false;
  const h = await harness(call => {
    if (call.url.pathname === `/v0/inboxes/${inboxId}`) return response(inbox);
    if (call.method === 'POST') return response({ message_id: '<sent@agentmail.to>', thread_id: 'new-provider-thread' });
    if (call.url.pathname === `/v0/inboxes/${inboxId}/messages`) return response({ messages: [{ message_id: '<sent@agentmail.to>' }] });
    if (decodeURIComponent(call.url.pathname.split('/').at(-1)!) === outgoing.inReplyTo) return response({ ...sentRaw(outgoing, outgoing.inReplyTo), thread_id: parentThread });
    const raw = { ...sentRaw(outgoing), thread_id: 'new-provider-thread', text: outgoing.body + '\n\n--\nSent via AgentMail' };
    if (wrongReferences) raw.references = ['<unrelated@example.cn>'];
    return response(raw);
  });
  try {
    const prepared = await h.provider.createDraft(outgoing);
    assert.deepEqual(await h.provider.sendDraft(prepared.draftId, outgoing), { messageId: '<sent@agentmail.to>', threadId: 'new-provider-thread' });
    const mutations = h.calls.filter(call => call.method === 'POST').length;
    assert.deepEqual(await h.provider.reconcileSent(outgoing), { messageId: '<sent@agentmail.to>', threadId: 'new-provider-thread' });
    parentThread = 'unrelated-thread';
    await assert.rejects(h.provider.reconcileSent(outgoing), error => error instanceof MailProviderError && error.code === 'mail_reconcile_conflict');
    parentThread = 'original-thread'; wrongReferences = true;
    await assert.rejects(h.provider.reconcileSent(outgoing), error => error instanceof MailProviderError && error.code === 'mail_reconcile_conflict');
    assert.equal(h.calls.filter(call => call.method === 'POST').length, mutations, 'reconciliation must never resend');
  } finally { await h.cleanup(); }
});
