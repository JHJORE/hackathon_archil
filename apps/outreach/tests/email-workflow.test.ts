import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Orchestrator } from '../server/orchestrator.js';
import { DEMO_RFQ } from '../server/fixtures.js';
import { emailNegotiationSchema, groundEmailExtraction, type EmailExtraction } from '../server/email-negotiation.js';
import { assertStrictSchema } from '../server/schema.js';
import { outgoingMailHash } from '../server/mail-content.js';
import type { Candidate, CaseState, EventBus, Message, ModelGateway, ModelJob, Quote, Store } from '../shared/types.js';
import type { EmailDraft, MailAccount, MailProvider, OutgoingMail, ReceivedMail, SendReceipt } from '../shared/email.js';

class MemoryStore implements Store {
  values = new Map<string, unknown>();
  failBefore?: (key: string, value: unknown) => boolean;
  async get<T>(key: string): Promise<T | null> { return this.values.has(key) ? structuredClone(this.values.get(key)) as T : null; }
  async put(key: string, value: unknown) {
    if (this.failBefore?.(key, value)) { this.failBefore = undefined; throw new Error('TEST storage interruption'); }
    this.values.set(key, structuredClone(value));
  }
  async putText(key: string, text: string) { await this.put(key, text); }
  async getText(key: string) { return this.get<string>(key); }
  async list(prefix: string) { return [...this.values.keys()].filter(key => key.startsWith(prefix)).sort(); }
  async immutable(key: string, value: unknown) {
    if (this.values.has(key)) assert.deepEqual(this.values.get(key), value, `immutable conflict ${key}`);
    else await this.put(key, value);
  }
}
class FakeMail implements MailProvider {
  user: MailAccount = { email: 'buyer@example.test', name: 'Test Buyer' };
  connected = true; creates = 0; sends = 0; reads = 0; reconciles = 0;
  loseSendResponse = false; rejectSend = false;
  sent = new Map<string, { mail: OutgoingMail; receipt: SendReceipt }>();
  messages = new Map<string, ReceivedMail>();
  async status() { return { configured: true, connected: this.connected, account: this.connected ? this.user : null, state: this.connected ? 'connected' as const : 'disconnected' as const, error: null }; }
  async connectInbox() { return this.user; }
  async account() { if (!this.connected) throw new Error('TEST disconnected'); return this.user; }
  async createDraft(mail: OutgoingMail) { assert.equal(mail.contentHash, outgoingMailHash(mail)); this.creates++; return { draftId: `operation-${mail.contentHash}` }; }
  async sendDraft(_draftId: string, mail: OutgoingMail) {
    assert.equal(mail.contentHash, outgoingMailHash(mail)); this.sends++;
    if (this.rejectSend) throw new Error('TEST send outcome unavailable');
    const receipt = { messageId: `<sent/${this.sends}@provider.test>`, threadId: mail.threadId ?? `thread-${this.sends}` };
    this.sent.set(mail.rfcMessageId, { mail: structuredClone(mail), receipt });
    if (this.loseSendResponse) { this.loseSendResponse = false; throw new Error('TEST response lost after send'); }
    return receipt;
  }
  async reconcileSent(mail: OutgoingMail) { this.reconciles++; return this.sent.get(mail.rfcMessageId)?.receipt ?? null; }
  async listThreadMessages(threadId: string) { return [...this.messages.values()].filter(m => m.threadId === threadId).map(m => ({ id: m.id, threadId: m.threadId })); }
  async readMessage(id: string) { this.reads++; const m = this.messages.get(id); assert.ok(m); return structuredClone(m); }
  add(body = offerText(0.075), overrides: Partial<ReceivedMail> = {}) {
    const message: ReceivedMail = { id: `<reply-${this.messages.size + 1}@supplier.test>`, threadId: 'thread-1', rfcMessageId: `<reply-${this.messages.size + 1}@supplier.test>`, from: 'sales@supplier.test', to: [this.user.email], subject: 'Re: Quote', body,
      receivedAt: `2026-11-11T12:00:0${this.messages.size}Z`, inReplyTo: '<sent/1@provider.test>', references: ['<sent/1@provider.test>'], autoSubmitted: false, truncated: false, attachments: [], raw: { text: body }, ...overrides };
    this.messages.set(message.id, message); return message;
  }
}
const events: EventBus = { emit: (type, message, data, caseId, supplierId) => ({ id: randomUUID(), at: new Date().toISOString(), type, message, data, caseId, supplierId }) };
const candidate: Candidate = {
  supplierId: 'supplier-one', companyName: 'TEST ONLY Supplier', chineseName: null, city: null, sourceUrl: 'https://supplier.test/products', publishedContacts: { emails: ['sales@supplier.test'], phones: [] },
  technicalFit: { score: 80, summary: 'TEST ONLY', standards: ['ISO 4762'], grades: ['12.9'], finish: 'black oxide' }, manufacturingEvidence: ['TEST ONLY factory claim'], certifications: [], identifiers: { uscc: null, icp: null }, evidenceQuotes: [], uncertainties: [],
  fingerprints: [{ url: 'https://supplier.test/products', sha256: 'TEST ONLY hash', fetchedAt: '2026-11-11T00:00:00Z', truncated: false }], identity: { domain: 'supplier.test', phones: [], uscc: null, icp: null },
};
function quote(price = 0.075): Quote { return { unitPrice: price, quantity: 50000, currency: 'USD', standard: 'ISO 4762', size: 'M8x30', grade: '12.9', finish: 'black oxide', incoterm: 'CIF', destination: 'Oakland', leadTimeDays: 21, notes: [] }; }
function offerText(price: number): string { return `Price USD ${price}; quantity 50000; ISO 4762; M8x30; grade 12.9; black oxide; CIF Oakland; lead time 21 days.`; }
function extraction(message: Message, price = Number(message.text.match(/USD ([\d.]+)/)?.[1] ?? 0.075)): EmailExtraction {
  const q = quote(price);
  return { quote: q, packageId: 'offer-A', alternatives: false, conditional: false, explanation: 'TEST ONLY extraction', clarificationQuestions: [], confirmation: null,
    evidence: Object.keys(q).filter(field => field !== 'notes').map(field => ({ field, messageId: message.messageId, excerpt: message.text, packageId: 'offer-A' })) };
}
class FakeModel implements ModelGateway {
  calls: ModelJob[] = [];
  produce: (job: ModelJob) => unknown = job => extraction((job.input as { inbound: Message }).inbound);
  before?: (job: ModelJob) => Promise<void>;
  async run<T>(job: ModelJob): Promise<T> { this.calls.push(job); await this.before?.(job); return this.produce(job) as T; }
}
async function setup(failpoint?: (stage: string, context: { caseId: string; messageId: string }) => void | Promise<void>) {
  const store = new MemoryStore(), mail = new FakeMail(), model = new FakeModel();
  const research = { run: async () => ({ candidates: [structuredClone(candidate)], uncertainties: [] }) };
  const make = (fail = failpoint) => new Orchestrator({ store, mail, model, research, events, failpoint: fail });
  const app = make(); const source = await app.create(); await app.start(source.id);
  const sourceBefore = new Map([...store.values].filter(([key]) => key.startsWith(`cases/${source.id}/`)));
  const state = await app.prepareEmailOutreach(source.id, [candidate.supplierId]);
  const draft = (await app.detail(state.id)).emailDrafts![0];
  return { store, mail, model, app, make, source, sourceBefore, state, draft };
}
const approve = (app: Orchestrator, draft: EmailDraft) => app.approveEmailDraft(draft.caseId, draft.id, { revision: draft.revision, contentHash: draft.contentHash });

test('email extraction schema is strict and rejects malformed output', () => {
  assert.doesNotThrow(() => assertStrictSchema(emailNegotiationSchema));
  const inbound: Message = { messageId: 'x', caseId: 'c', supplierId: 's', text: offerText(0.075), createdAt: '', direction: 'inbound', simulated: false };
  assert.throws(() => groundEmailExtraction({ quote: { unitPrice: 0.1 } }, inbound, []), /Invalid structured output/);
});

test('fresh email outreach copies only selected supported candidates and leaves its source unchanged', async () => {
  const { app, state, source, sourceBefore, store, mail, draft } = await setup();
  assert.equal(state.communicationMode, 'email'); assert.equal(state.sourceCaseId, source.id); assert.notEqual(state.id, source.id);
  assert.deepEqual(state.rfq, source.rfq); assert.equal(state.suppliers.length, 1); assert.equal(state.suppliers[0].round, 0);
  assert.deepEqual((await app.detail(state.id)).conversations[candidate.supplierId], []);
  assert.equal(draft.status, 'pending approval'); assert.match(draft.body, /Test Buyer/); assert.doesNotMatch(draft.body, /SIMULATED/);
  assert.equal(mail.creates, 0); assert.equal(mail.sends, 0);
  assert.deepEqual(new Map([...store.values].filter(([key]) => key.startsWith(`cases/${source.id}/`))), sourceBefore);
  await assert.rejects(app.prepareEmailOutreach(source.id, ['unknown']), /saved source evidence/);
  await assert.rejects(app.prepareEmailOutreach(source.id, ['supplier-one', 'supplier-one']), /distinct/);
  await assert.rejects(app.demo(state.id, 'initial-quotes'), /disabled/);
  await assert.rejects(app.receive(state.id, { messageId: 'fake', supplierId: 'supplier-one', text: 'fake' }), /disabled/);
});

test('incomplete RFQs prepare reviewed quotation requests without invented terms or automatic sends', async () => {
  const { app, source, store, mail } = await setup();
  const state = (await app.detail(source.id)).state;
  state.rfq = {...state.rfq,grade:null,quantity:null,targetUnitPrice:null,maxUnitPrice:null};
  await store.put(`cases/${source.id}/state.json`,state);
  const prepared = await app.prepareEmailOutreach(source.id,[candidate.supplierId]);
  const detail = await app.detail(prepared.id);
  assert.match(detail.emailDrafts![0].body,/Quantity: Please propose \/ confirm/);
  assert.doesNotMatch(detail.emailDrafts![0].body,/null/);
  assert.equal(mail.sends,0);
  await approve(app,detail.emailDrafts![0]);
  assert.equal(mail.sends,1);
});

test('incoming email with incomplete buyer terms is retained without a target-met claim or reply draft', async () => {
  const { app, state, draft, store, mail } = await setup();
  await approve(app, draft);
  const saved = (await app.detail(state.id)).state;
  saved.rfq = { ...saved.rfq, maxUnitPrice: null };
  await store.put(`cases/${state.id}/state.json`, saved);
  const reply = mail.add(offerText(0.064));
  await app.syncEmail(); await app.waitForIdle();
  const detail = await app.detail(state.id), supplier = detail.state.suppliers[0];
  assert.equal(supplier.latestOffer?.unitPrice, 0.064); assert.equal(supplier.status, 'needs attention');
  assert.equal(supplier.round, 0); assert.match(supplier.explanation, /maxUnitPrice/);
  assert.ok(detail.conversations[candidate.supplierId].some(message => message.email?.providerMessageId === reply.id));
  assert.equal(detail.emailDrafts!.length, 1); assert.equal(mail.sends, 1);
});

test('edit invalidates old approval and duplicate exact approvals send only once', async () => {
  const { app, draft, mail, state } = await setup();
  const updated = await app.editEmailDraft(state.id, draft.id, { revision: draft.revision, to: 'reviewed@supplier.test', subject: draft.subject, body: `${draft.body}\nPlease reply by Friday.` });
  assert.equal(updated.revision, 2); assert.notEqual(updated.contentHash, draft.contentHash); assert.equal(updated.approvedHash, null); assert.equal(updated.contactSourceUrl, null);
  await assert.rejects(approve(app, draft), /content changed/);
  await Promise.all([approve(app, updated), approve(app, updated)]);
  assert.equal(mail.sends, 1); assert.equal(mail.creates, 1);
  const detail = await app.detail(state.id);
  assert.equal(detail.emailDrafts![0].status, 'sent');
  assert.equal(detail.conversations['supplier-one'].length, 1); assert.equal(detail.conversations['supplier-one'][0].simulated, false);
  assert.equal(detail.conversations['supplier-one'][0].email!.rfcMessageId, '<sent/1@provider.test>');
  await assert.rejects(app.editEmailDraft(state.id, updated.id, { revision: 2, to: updated.to, subject: updated.subject, body: 'changed' }), /cannot be edited/);
});

test('email outreach retains imported RFQ provenance without changing its source or sending mail', async () => {
  const { app, source, store, mail } = await setup();
  const sourceState = (await app.detail(source.id)).state;
  sourceState.rfqSource = { id: 'test-source', kind: 'archil', diskId: 'dsk-test', diskName: 'TEST ONLY Scout', path: 'rfqs/test.json', sha256: 'a'.repeat(64), revision: 'test-revision', title: 'TEST ONLY imported RFQ', importedAt: '2026-11-11T00:00:00Z', warnings: ['TEST source warning'], snapshotKey: 'imports/test-source/snapshot.json', snapshotSha256: 'b'.repeat(64) };
  sourceState.uncertainties.push('TEST source warning');
  await store.put(`cases/${source.id}/state.json`, sourceState);
  const before = new Map([...store.values].filter(([key]) => key.startsWith(`cases/${source.id}/`)).map(([key, value]) => [key, structuredClone(value)]));
  const prepared = await app.prepareEmailOutreach(source.id, [candidate.supplierId]);
  assert.deepEqual(prepared.rfqSource, sourceState.rfqSource); assert.equal(prepared.sourceCaseId, source.id);
  assert.ok(prepared.uncertainties.includes('TEST source warning'));
  assert.deepEqual(new Map([...store.values].filter(([key]) => key.startsWith(`cases/${source.id}/`))), before);
  assert.equal(mail.creates, 0); assert.equal(mail.sends, 0);
});

test('missing recipient requires entry and disconnected sync is quiet', async () => {
  const { app, draft, state, mail } = await setup();
  const empty = await app.editEmailDraft(state.id, draft.id, { revision: 1, to: '', subject: draft.subject, body: draft.body });
  await assert.rejects(approve(app, empty), /valid recipient/); assert.equal(mail.sends, 0);
  mail.connected = false; assert.deepEqual(await app.syncEmail(), { processed: 0 });
});

for (const stage of ['email-intent-saved', 'email-provider-draft-saved', 'email-send-attempt-saved', 'email-receipt-saved']) {
  test(`send recovery preserves approval and no duplicate send after ${stage}`, async () => {
    let fired = false;
    const { app, state, draft, mail, make } = await setup(at => { if (at === stage && !fired) { fired = true; throw new Error('TEST abrupt interruption'); } });
    await approve(app, draft).catch(() => {});
    const recovered = make(undefined); await recovered.recover();
    const after = (await recovered.detail(state.id)).emailDrafts![0];
    if (stage === 'email-send-attempt-saved') {
      assert.equal(after.status, 'send unknown'); assert.equal(mail.sends, 0);
      await approve(recovered, after); assert.equal(mail.sends, 0);
    } else if (stage === 'email-receipt-saved') {
      assert.equal(after.status, 'sent'); assert.equal(mail.sends, 1); await approve(recovered, after); assert.equal(mail.sends, 1);
    } else {
      assert.equal(mail.sends, 0); assert.ok(['pending approval', 'failed'].includes(after.status));
      await approve(recovered, after); assert.equal(mail.sends, 1);
    }
  });
}

test('lost provider response reconciles the sent receipt without resending', async () => {
  const { app, draft, mail, make, state } = await setup();
  mail.loseSendResponse = true;
  await assert.rejects(approve(app, draft), /response lost/);
  assert.equal((await app.detail(state.id)).emailDrafts![0].status, 'send unknown');
  const recovered = make(); await recovered.recover();
  assert.equal((await recovered.detail(state.id)).emailDrafts![0].status, 'sent'); assert.equal(mail.sends, 1);
  await approve(recovered, (await recovered.detail(state.id)).emailDrafts![0]); assert.equal(mail.sends, 1);
});

test('outbound projection failure after receipt cannot cause a repeated send', async () => {
  const { app, draft, mail, store } = await setup();
  store.failBefore = key => key === `cases/${draft.caseId}/conversations/supplier-one.json`;
  await approve(app, draft);
  assert.equal(mail.sends, 1);
  assert.equal((await app.detail(draft.caseId)).emailDrafts![0].status, 'sent');
});

test('real replies persist raw first, create reviewed counter draft, deduplicate and update final offer', async () => {
  const { app, draft, mail, model, store, state, make } = await setup();
  await approve(app, draft);
  model.before = async job => {
    assert.equal(job.priority, 1);
    assert.ok((await store.list(`cases/${state.id}/email/raw/`)).length > 0, 'raw provider message precedes extraction');
  };
  mail.add(); await app.syncEmail();
  let detail = await app.detail(state.id);
  const counter = detail.emailDrafts!.find(d => d.kind === 'counteroffer')!;
  assert.equal(counter.status, 'pending approval'); assert.equal(mail.sends, 1); assert.equal(detail.state.suppliers[0].round, 0);
  assert.equal(detail.quoteEvidence!['supplier-one'].length, 10);
  await app.syncEmail(); assert.equal(model.calls.length, 1); assert.equal(mail.reads, 1);
  await approve(app, counter); assert.equal(mail.sends, 2);
  mail.add(offerText(0.064)); await app.syncEmail();
  detail = await app.detail(state.id);
  assert.equal(detail.state.suppliers[0].status, 'target met'); assert.equal(detail.state.suppliers[0].round, 1);
  assert.equal(detail.state.suppliers[0].latestOffer!.unitPrice, 0.064);
  assert.equal(detail.emailDrafts!.filter(d => d.kind === 'counteroffer').length, 1);
  const recovered = make(); await recovered.recover();
  assert.equal((await recovered.detail(state.id)).state.suppliers[0].status, 'target met');
  assert.equal((await recovered.detail(state.id)).state.status, 'complete');
  assert.equal(mail.sends, 2);
});

test('a newer reply invalidates approval of an older pending counter', async () => {
  const { app, draft, mail, state } = await setup();
  await approve(app, draft); mail.add(); await app.syncEmail();
  const counter = (await app.detail(state.id)).emailDrafts!.find(d => d.kind === 'counteroffer')!;
  mail.add(offerText(0.064)); await app.syncEmail();
  await assert.rejects(approve(app, counter), /newer supplier reply/);
  assert.equal(mail.sends, 1);
});

test('self and automatic replies are ignored; unknown, attachment-only and truncated messages need attention', async () => {
  const { app, draft, mail, model, state } = await setup(); await approve(app, draft);
  mail.add('sent copy', { from: mail.user.email }); mail.add('Out of office', { autoSubmitted: true });
  await app.syncEmail(); assert.equal(model.calls.length, 0);
  mail.add(offerText(0.064), { from: 'unknown@elsewhere.test' });
  mail.add('', { attachments: [{ filename: 'quote.pdf', mimeType: 'application/pdf' }] });
  mail.add(offerText(0.064), { truncated: true });
  await app.syncEmail();
  assert.equal(model.calls.length, 0); assert.equal((await app.detail(state.id)).state.suppliers[0].status, 'needs attention');
  assert.equal(mail.sends, 1);
});

test('conditions, alternatives and unsupported Chinese aliases require clarification instead of invented terms', async () => {
  const { app, draft, mail, model, state } = await setup(); await approve(app, draft);
  model.produce = job => { const result = extraction((job.input as { inbound: Message }).inbound); result.conditional = true; result.alternatives = true; return result; };
  mail.add(`${offerText(0.064)} Subject to a different finish; option B is USD 0.080.`); await app.syncEmail();
  assert.equal((await app.detail(state.id)).state.suppliers[0].status, 'needs attention');
  assert.ok((await app.detail(state.id)).emailDrafts!.some(d => d.kind === 'clarification' && d.status === 'pending approval'));
  model.produce = job => extraction((job.input as { inbound: Message }).inbound, 0.064);
  mail.add('单价 0.064 美元，50000件，ISO 4762 M8x30，12.9级，black oxide，CIF 奥克兰，交期21天。'); await app.syncEmail();
  const detail = await app.detail(state.id);
  assert.equal(detail.state.suppliers[0].latestOffer!.currency, null); assert.equal(detail.state.suppliers[0].latestOffer!.destination, null);
  assert.equal(detail.state.suppliers[0].status, 'needs attention'); assert.equal(mail.sends, 1);
});

test('grounding rejects numeric suffix matches, negated confirmation and mixed packages', () => {
  const inbound: Message = { messageId: 'current', caseId: 'case', supplierId: 'supplier', text: 'USD 10.065 for 150000 pcs; ISO 4762 M8x30 Grade 112.9 black oxide CIF Oakland lead 15 days.', createdAt: '', direction: 'inbound', simulated: false };
  const data = extraction(inbound, 0.065); data.quote.leadTimeDays = 5;
  let grounded = groundEmailExtraction(data, inbound, []);
  for (const field of ['unitPrice', 'quantity', 'grade', 'leadTimeDays'] as const) assert.equal(grounded.result.quote[field], null);
  const earlier = { ...inbound, messageId: 'prior', text: offerText(0.075) };
  const negative = { ...inbound, text: 'We cannot confirm the previous offer.' };
  const confirmation = extraction(earlier);
  confirmation.confirmation = { messageId: negative.messageId, excerpt: negative.text, confirmsMessageId: earlier.messageId };
  grounded = groundEmailExtraction(confirmation, negative, [earlier]);
  assert.equal(grounded.result.quote.unitPrice, null);
  const mixed = extraction(earlier); mixed.evidence[0].packageId = 'different-offer';
  assert.equal(groundEmailExtraction(mixed, earlier, []).result.quote.unitPrice, null);
  const unavailable = { ...earlier, text: `${earlier.text} Grade 12.9 is unavailable; we can only supply grade 8.8 instead.` };
  assert.ok(groundEmailExtraction(extraction(unavailable), unavailable, []).issues.some(issue => issue.includes('substitution')));
});

test('price evidence accepts a sentence-final period without accepting numeric suffixes', () => {
  const inbound: Message = { messageId: 'price-period', caseId: 'case', supplierId: 'supplier', text: `Unit price USD 0.075.\n${offerText(0.075)}`, createdAt: '', direction: 'inbound', simulated: false };
  const data = extraction(inbound, 0.075);
  data.evidence.find(item => item.field === 'unitPrice')!.excerpt = 'Unit price USD 0.075.';
  assert.equal(groundEmailExtraction(data, inbound, []).result.quote.unitPrice, 0.075);
  const misleading = { ...inbound, text: 'Unit price USD 10.075.' };
  data.evidence.find(item => item.field === 'unitPrice')!.excerpt = misleading.text;
  assert.equal(groundEmailExtraction(data, misleading, []).result.quote.unitPrice, null);
});

test('newest-first provider metadata still processes offers chronologically', async () => {
  const { app, draft, mail, state, make } = await setup(); await approve(app, draft);
  mail.add(offerText(0.064), { receivedAt: '2026-11-11T14:00:00Z' });
  mail.add(offerText(0.075), { receivedAt: '2026-11-11T13:00:00Z' });
  await app.syncEmail();
  assert.equal((await app.detail(state.id)).state.suppliers[0].latestOffer!.unitPrice, 0.064);
  const recovered = make(); await recovered.recover();
  assert.equal((await recovered.detail(state.id)).state.suppliers[0].latestOffer!.unitPrice, 0.064);
});

test('an interrupted older decision blocks newer processing until ordered recovery', async () => {
  let failed = false;
  const { app, draft, mail, state, model } = await setup(stage => { if (stage === 'email-decision-saved' && !failed) { failed = true; throw new Error('TEST older reply crash'); } });
  await approve(app, draft); mail.add(offerText(0.075)); mail.add(offerText(0.064));
  await app.syncEmail(); assert.equal(model.calls.length, 1);
  await app.syncEmail();
  assert.equal(model.calls.length, 2);
  assert.equal((await app.detail(state.id)).state.suppliers[0].latestOffer!.unitPrice, 0.064);
  await app.syncEmail(); assert.equal((await app.detail(state.id)).state.suppliers[0].status, 'target met');
});

test('manual and periodic sync cannot overlap while provider status is pending', async () => {
  const { app, mail } = await setup();
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  let statusCalls = 0;
  const original = mail.status.bind(mail);
  mail.status = async () => { statusCalls++; await barrier; return original(); };
  const first = app.syncEmail();
  assert.deepEqual(await app.syncEmail(), { processed: 0 });
  assert.equal(statusCalls, 1);
  release(); await first;
  await app.syncEmail(); assert.equal(statusCalls, 2);
});

test('a late older email is retained in history without overwriting a newer final offer', async () => {
  const { app, draft, mail, state } = await setup(); await approve(app, draft);
  mail.add(offerText(0.064), { receivedAt: '2026-11-11T15:00:00Z' }); await app.syncEmail();
  mail.add(offerText(0.075), { receivedAt: '2026-11-11T13:00:00Z' }); await app.syncEmail();
  const detail = await app.detail(state.id);
  assert.equal(detail.state.suppliers[0].latestOffer!.unitPrice, 0.064); assert.equal(detail.state.suppliers[0].status, 'target met');
  assert.deepEqual(detail.offerHistory!['supplier-one'].map(item => item.quote.unitPrice), [0.075, 0.064]);
});

test('interrupted preparation with no send-attempt recovers to reviewable state without sending', async () => {
  const { app, draft, store, mail, make, state } = await setup();
  await store.put(`cases/${state.id}/email/drafts/${draft.id}.json`, { ...draft, status: 'sending', providerDraftId: 'TEST prepared op' });
  const recovered = make(); await recovered.recover();
  const current = (await recovered.detail(state.id)).emailDrafts![0];
  assert.equal(current.status, 'failed'); assert.equal(mail.sends, 0);
  await approve(recovered, current); assert.equal(mail.sends, 1);
});

test('an unknown counter send consumes the one-counter limit without generating or retrying another', async () => {
  const { app, draft, mail, state } = await setup(); await approve(app, draft);
  mail.add(); await app.syncEmail();
  const counter = (await app.detail(state.id)).emailDrafts!.find(d => d.kind === 'counteroffer')!;
  mail.rejectSend = true; await assert.rejects(approve(app, counter), /outcome unavailable/);
  assert.equal(mail.sends, 2);
  mail.add(offerText(0.074)); await app.syncEmail();
  const detail = await app.detail(state.id);
  assert.equal(detail.state.suppliers[0].round, 1); assert.equal(detail.emailDrafts!.filter(d => d.kind === 'counteroffer').length, 1);
  await approve(app, detail.emailDrafts!.find(d => d.kind === 'counteroffer')!);
  assert.equal(mail.sends, 2);
});

test('inbox receipt recovery repairs an interrupted latest-message pointer before approval', async () => {
  const { app, draft, store, mail, state } = await setup(); await approve(app, draft); mail.add();
  store.failBefore = key => key.includes('/latest-inbound/');
  await assert.rejects(app.syncEmail(), /storage interruption/);
  await app.syncEmail();
  const counter = (await app.detail(state.id)).emailDrafts!.find(d => d.kind === 'counteroffer')!;
  assert.ok(counter); await approve(app, counter); assert.equal(mail.sends, 2);
});

test('failure marking a processed provider message seen cannot corrupt its completed offer', async () => {
  const { app, draft, store, mail, state, model } = await setup(); await approve(app, draft); mail.add(offerText(0.064));
  store.failBefore = key => key.includes('/email/seen/');
  await app.syncEmail(); assert.equal((await app.detail(state.id)).state.suppliers[0].status, 'target met');
  await app.syncEmail(); assert.equal((await app.detail(state.id)).state.suppliers[0].status, 'target met'); assert.equal(model.calls.length, 1);
});

test('follow-up drafts to an operator-overridden recipient do not claim published contact provenance', async () => {
  for (const [body, kind] of [[offerText(0.075), 'counteroffer'], ['No, I do not have that.', 'clarification']] as const) {
    const { app, draft, mail, state } = await setup();
    const edited = await app.editEmailDraft(state.id, draft.id, { revision: draft.revision, to: 'operator@example.test', subject: draft.subject, body: draft.body });
    await approve(app, edited);
    mail.add(body, { from: 'operator@example.test' }); await app.syncEmail();
    const detail = await app.detail(state.id);
    const followup = detail.emailDrafts!.find(item => item.kind === kind)!;
    assert.ok(followup); assert.equal(followup.to, 'operator@example.test'); assert.equal(followup.contactSourceUrl, null);
    assert.deepEqual(detail.state.suppliers[0].supplier.publishedContacts.emails, ['sales@supplier.test']);
  }
});

test('a nonquote reply does not consume the initial priced offer used for savings', async () => {
  const { app, draft, mail, state } = await setup(); await approve(app, draft);
  mail.add('No, I do not have that.'); await app.syncEmail();
  assert.equal((await app.detail(state.id)).state.suppliers[0].originalOffer, null);
  mail.add(offerText(0.075)); await app.syncEmail();
  assert.equal((await app.detail(state.id)).state.suppliers[0].originalOffer!.unitPrice, 0.075);
  mail.add(offerText(0.064)); await app.syncEmail();
  const supplier = (await app.detail(state.id)).state.suppliers[0];
  assert.equal(supplier.originalOffer!.unitPrice, 0.075); assert.equal(supplier.latestOffer!.unitPrice, 0.064);
});
