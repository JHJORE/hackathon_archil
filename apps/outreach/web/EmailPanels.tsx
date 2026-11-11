import React, { useEffect, useState } from 'react';
import type { CaseState, Message } from '../shared/types';
import type { EmailDraft, EmailStatus, QuoteEvidence } from '../shared/email';

async function emailApi<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const result = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const value = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(typeof value.error === 'string' ? value.error : value.error?.message || value.message || `Request failed (${result.status})`);
  return value as T;
}
const formatTime = (value: string | null | undefined) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Not synced yet';
const allowedUrl = (value: string | null) => value && /^https?:\/\//i.test(value) ? value : null;

export function EmailConnectionPanel({ status, onRefresh }: { status: EmailStatus | null; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState<'connect' | 'sync' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const connect = async () => { setBusy('connect'); setError(null); try { await emailApi<EmailStatus>('/api/email/connect', 'POST', {}); await onRefresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };
  const sync = async () => { setBusy('sync'); setError(null); setResult(null); try { const value = await emailApi<{ processed: number }>('/api/email/sync', 'POST', {}); setResult(`${value.processed} ${value.processed === 1 ? 'reply' : 'replies'} processed.`); await onRefresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };
  return <section className="email-connection" aria-label="AgentMail connection"><div className="email-connection-main"><span className="mail-provider-symbol" aria-hidden="true">@</span><div className="email-connection-title"><strong>AgentMail <span className={`email-state ${status?.connected ? 'connected' : ''}`}>{status?.connected ? 'Connected' : status?.state || 'Checking connection'}</span></strong><p>{status?.account?.email || 'A dedicated inbox for reviewed outreach and real supplier replies.'}</p></div><div className="email-sync-meta"><span>Last sync <b>{formatTime(status?.lastSyncAt)}</b></span><span><b>{status?.pendingApprovals ?? 0}</b> awaiting approval</span></div><div className="email-connection-actions">{status?.connected ? <button className="button button-secondary" onClick={() => void sync()} disabled={busy !== null || status.syncing}>{busy === 'sync' || status.syncing ? 'Checking replies…' : 'Check replies now'}</button> : <button className="button button-secondary" disabled={busy !== null || !status?.configured} onClick={() => void connect()}>{busy === 'connect' ? 'Connecting inbox…' : 'Connect inbox'}</button>}</div></div>
    {status && !status.configured && <div className="email-setup"><p>Run npm run connect:email in a private Terminal from the app workspace to save the AgentMail key locally, then connect your dedicated inbox here.</p><a href="https://console.agentmail.to" target="_blank" rel="noreferrer">Open AgentMail console ↗</a></div>}
    {(error || status?.error || status?.syncError) && <p className="email-error" role="alert">{error || status?.syncError || status?.error}</p>}
    {result && <p className="email-result" role="status">{result}</p>}
  </section>;
}

export function OutreachDialog({ state, connected, onClose, onCreated }: { state: CaseState; connected: boolean; onClose: () => void; onCreated: (state: CaseState) => void }) {
  const available = state.suppliers;
  const [selected, setSelected] = useState<string[]>(available.slice(0, 3).map(s => s.supplier.supplierId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prepare = async () => { setBusy(true); setError(null); try { const next = await emailApi<CaseState>(`/api/cases/${state.id}/email-outreach`, 'POST', { supplierIds: selected }); onCreated(next); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div className="modal-backdrop" onClick={() => !busy && onClose()}><section className="import-modal outreach-modal" role="dialog" aria-modal="true" aria-labelledby="outreach-title" onClick={e => e.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow">REVIEWED SUPPLIER OUTREACH</span><h2 id="outreach-title">Choose email recipients</h2></div><button className="icon-button" aria-label="Close outreach selection" disabled={busy} onClick={onClose}>✕</button></div><p>Select up to three suppliers from your evidence-backed shortlist. Add a recipient in the draft when no published email is available. This creates a separate real-email case and reviewable drafts. Sending requires your approval of each draft.</p><div className="outreach-selection">{state.suppliers.map(({ supplier }) => { return <label className={`outreach-option ${selected.includes(supplier.supplierId) ? 'selected' : ''}`} key={supplier.supplierId}><input type="checkbox" checked={selected.includes(supplier.supplierId)} disabled={busy || (!selected.includes(supplier.supplierId) && selected.length >= 3)} onChange={e => setSelected(old => e.target.checked ? [...old, supplier.supplierId] : old.filter(id => id !== supplier.supplierId))}/><span><strong>{supplier.companyName}</strong><span className="outreach-email">{supplier.publishedContacts.emails[0] || 'Enter recipient in draft'}</span><small>{supplier.city || 'Location unconfirmed'} · recipient can be edited in the draft</small>{allowedUrl(supplier.sourceUrl) && <a href={supplier.sourceUrl} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>Review supplier source ↗</a>}</span></label>; })}</div>{!connected && <p className="email-error">Connect the AgentMail inbox above before preparing real-email outreach.</p>}{error && <p className="email-error" role="alert">{error}</p>}<div className="modal-actions"><button className="button button-secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy || !connected || selected.length < 1} onClick={() => void prepare()}>{busy ? 'Creating drafts…' : `Create ${selected.length || ''} reviewed ${selected.length === 1 ? 'draft' : 'drafts'}`}</button></div></section></div>;
}

function DraftEditor({ draft, onRefresh }: { draft: EmailDraft; onRefresh: () => Promise<void> }) {
  const [saved, setSaved] = useState(draft);
  const [to, setTo] = useState(draft.to), [subject, setSubject] = useState(draft.subject), [body, setBody] = useState(draft.body);
  const [busy, setBusy] = useState<'save' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recipientValid = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to.trim());
  const dirty = to !== saved.to || subject !== saved.subject || body !== saved.body;
  const current = saved.updatedAt > draft.updatedAt ? saved : draft;
  const stale = draft.revision > saved.revision;
  const superseded = current.status === 'failed' && current.error?.includes('superseded');
  const editable = !superseded && ['pending approval', 'failed'].includes(current.status);
  const adopt = (value: EmailDraft) => { setSaved(value); setTo(value.to); setSubject(value.subject); setBody(value.body); setError(null); };
  useEffect(() => { if (!dirty) adopt(draft); }, [draft]);
  const save = async () => { setBusy('save'); setError(null); try { const next = await emailApi<EmailDraft>(`/api/cases/${draft.caseId}/email-drafts/${draft.id}`, 'PATCH', { revision: saved.revision, to, subject, body }); adopt(next); await onRefresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(null); } };
  const send = async () => {
    if (dirty || stale || !editable || busy || !recipientValid || !subject.trim() || !body.trim()) return;
    setBusy('send'); setError(null);
    try { const next = await emailApi<EmailDraft>(`/api/cases/${draft.caseId}/email-drafts/${draft.id}/approve-send`, 'POST', { revision: current.revision, contentHash: current.contentHash }); adopt(next); await onRefresh(); }
    catch (e) { setError((e as Error).message); await onRefresh(); }
    finally { setBusy(null); }
  };
  return <details className="email-draft" open={current.status !== 'sent'}><summary><span><strong>{draft.kind === 'rfq' ? 'RFQ email' : draft.kind === 'counteroffer' ? 'Counteroffer email' : 'Clarification email'}</strong><small>Revision {current.revision}</small></span><span className={`draft-status ${current.status.replaceAll(' ', '-')}`}>{current.status}</span></summary><div className="email-draft-content"><div className="draft-from"><span>FROM</span><strong>{current.from.name ? `${current.from.name} <${current.from.email}>` : current.from.email}</strong></div><label>Recipient<input type="email" value={to} onChange={e => setTo(e.target.value)} disabled={!editable || busy !== null} required/></label><label>Subject<input value={subject} onChange={e => setSubject(e.target.value)} disabled={!editable || busy !== null} required/></label><label>Message<textarea rows={9} value={body} onChange={e => setBody(e.target.value)} disabled={!editable || busy !== null} required/></label>{allowedUrl(current.contactSourceUrl) && <a className="draft-source" href={current.contactSourceUrl!} target="_blank" rel="noreferrer">Published contact source ↗</a>}{current.sourceMessageId && <p className="draft-provenance">Prepared in response to message <code>{current.sourceMessageId}</code></p>}{current.status === 'send unknown' && <p className="email-error">Delivery is not confirmed. Sending again is disabled until the server reconciles this message with the email provider.</p>}{(error || current.error) && <p className="email-error" role="alert">{error || current.error}</p>}{stale && <div className="draft-change-note"><span>A newer saved revision exists.</span><button className="text-button" onClick={() => adopt(draft)}>Reload latest draft</button></div>}{editable && <>{!recipientValid && <p className="draft-provenance">Enter and save a valid recipient email before approving this message.</p>}<p className="draft-review-note">{dirty ? 'You have unsaved edits. Save them before approving this exact recipient and message.' : 'Review the recipient and message above. Approval sends this saved revision as a real email. AgentMail may append its service footer.'}</p><div className="draft-actions"><button className="button button-secondary" disabled={!dirty || stale || busy !== null || !subject.trim() || !body.trim()} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save edits'}</button><button className="button button-primary" disabled={dirty || stale || busy !== null || !recipientValid || !subject.trim() || !body.trim()} onClick={() => void send()}>{busy === 'send' ? 'Sending…' : 'Approve & send email'}</button></div></>}{current.status === 'sent' && <p className="draft-sent">Sent through AgentMail · {current.providerMessageId}</p>}</div></details>;
}

export function EmailDrafts({ drafts, onRefresh }: { drafts: EmailDraft[]; onRefresh: () => Promise<void> }) {
  return <section className="email-drafts" aria-label="Email drafts requiring review"><div className="email-section-heading"><h3>Reviewed email drafts</h3><span className="tag">APPROVAL REQUIRED</span></div>{drafts.length ? drafts.map(draft => <DraftEditor key={draft.id} draft={draft} onRefresh={onRefresh}/>) : <p className="email-section-empty">No outgoing draft for this supplier yet. Incoming replies can produce a counteroffer or clarification for your review.</p>}</section>;
}

export function QuoteSourceEvidence({ entries, messages }: { entries: QuoteEvidence[]; messages: Message[] }) {
  if (!entries.length) return null;
  return <details className="quote-source-evidence"><summary>Quote evidence from supplier emails <span>{entries.length}</span></summary><div>{entries.map((entry, i) => { const message = messages.find(m => m.messageId === entry.messageId || m.email?.providerMessageId === entry.messageId); return <blockquote key={`${entry.packageId}-${entry.field}-${i}`}><span className="eyebrow">{entry.field.replaceAll('_', ' ')}</span><p>“{entry.excerpt}”</p>{message?.email && <small>{message.email.from} · {formatTime(message.createdAt)} · {message.email.subject}</small>}<code>Message {entry.messageId} · Evidence {entry.packageId}</code></blockquote>; })}</div></details>;
}
