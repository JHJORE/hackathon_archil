import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Orchestrator } from '../server/orchestrator.js';
import { DEMO_RFQ, quoteMessage } from '../server/fixtures.js';
import { evaluateQuote } from '../server/negotiation-schema.js';
import type { AppEvent, Candidate, EventBus, ModelGateway, ModelJob, NegotiationResult, Quote, Rfq, Store } from '../shared/types.js';

class MemoryStore implements Store {
  objects = new Map<string, unknown>();
  failBeforeWrite?: (key: string, value: unknown) => boolean;
  failAfterWrite?: (key: string, value: unknown) => boolean;
  async get<T>(key: string): Promise<T | null> { return this.objects.has(key) ? structuredClone(this.objects.get(key)) as T : null; }
  async put(key: string, value: unknown) {
    if (this.failBeforeWrite?.(key, value)) { this.failBeforeWrite = undefined; throw new Error('TEST interrupted persistence'); }
    this.objects.set(key, structuredClone(value));
    if (this.failAfterWrite?.(key, value)) { this.failAfterWrite = undefined; throw new Error('TEST committed write response was lost'); }
  }
  async putText(key: string, value: string) { this.objects.set(key, value); }
  async getText(key: string) { return this.objects.get(key) as string ?? null; }
  async list(prefix: string) { return [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort(); }
  async immutable(key: string, value: unknown) {
    if (this.objects.has(key)) assert.deepEqual(this.objects.get(key), value, `immutable conflict: ${key}`);
    else await this.put(key, value);
  }
}
class Bus implements EventBus {
  events: AppEvent[] = [];
  emit(type: string, message: string, data?: Record<string, unknown>, caseId?: string, supplierId?: string): AppEvent {
    const event = { id: randomUUID(), at: new Date().toISOString(), type, message, data, caseId, supplierId };
    this.events.push(event); return event;
  }
}
function candidate(id: string): Candidate {
  return {
    supplierId: id, companyName: `TEST ONLY ${id}`, chineseName: null, city: null, sourceUrl: `https://${id}.example.test/`,
    publishedContacts: { emails: [], phones: [] }, technicalFit: { score: 80, summary: 'TEST ONLY fixture', standards: ['ISO 4762'], grades: ['12.9'], finish: 'black oxide' },
    manufacturingEvidence: [], certifications: [], identifiers: { uscc: null, icp: null }, evidenceQuotes: [], uncertainties: ['TEST ONLY'], fingerprints: [], identity: { domain: null, phones: [], uscc: null, icp: null },
  };
}
function quote(unitPrice = 0.075, overrides: Partial<Quote> = {}): Quote {
  return { unitPrice, currency: 'USD', quantity: 50000, standard: 'ISO 4762', size: 'M8x30', grade: '12.9', finish: 'black oxide', incoterm: 'CIF', destination: 'Oakland', leadTimeDays: 21, notes: [], ...overrides };
}
class FakeModel implements ModelGateway {
  jobs: ModelJob[] = []; active = 0; maxActive = 0; responses: Quote[] = []; delay = 5;
  async run<T>(job: ModelJob): Promise<T> {
    this.jobs.push(job); this.active++; this.maxActive = Math.max(this.maxActive, this.active);
    const q = this.responses.shift() ?? quote();
    await new Promise(resolve => setTimeout(resolve, this.delay)); this.active--;
    return { quote: q, counterofferText: 'TEST ONLY proposed model text', explanation: 'TEST ONLY extraction' } as NegotiationResult as T;
  }
}
async function setup(failpoint?: (stage: string) => void) {
  const store = new MemoryStore(), model = new FakeModel(), events = new Bus();
  const research = { run: async () => ({ candidates: ['s1', 's2', 's3'].map(candidate), uncertainties: [] }) };
  const app = new Orchestrator({ store, model, research, events, failpoint });
  const state = await app.create(); await app.start(state.id);
  return { store, model, events, research, app, id: state.id };
}

test('three different suppliers run model jobs concurrently without holding the case mutex', async () => {
  const { app, id, model, store } = await setup();
  await app.demo(id, 'initial-quotes'); await app.waitForIdle();
  assert.equal(model.maxActive, 3); assert.equal(model.jobs.length, 3);
  assert.ok(model.jobs.every(job => job.priority === 1));
  const detail = await app.detail(id);
  assert.ok(detail.state.suppliers.every(s => s.round === 1 && s.status === 'negotiating'));
  assert.equal((await store.list(`cases/${id}/outbox/`)).length, 6);
  assert.ok(Object.values(detail.conversations).every(messages => messages.length === 3));
});

test('duplicate deliveries neither rerun the model nor send a second counter', async () => {
  const { app, id, model, store } = await setup();
  await app.demo(id, 'initial-quotes'); await app.waitForIdle();
  const result = await app.demo(id, 'duplicate'); await app.waitForIdle();
  assert.equal(result.duplicates, 1); assert.equal(model.jobs.length, 3);
  assert.equal((await store.list(`cases/${id}/outbox/`)).length, 6);
  await assert.rejects(app.receive(id, { supplierId: 's1', messageId: 'demo-initial-s1', text: 'changed payload' }), /different payload/);
});

test('same supplier messages serialize and cannot generate a second round', async () => {
  const { app, id, model, store } = await setup();
  model.responses = [quote(0.075), quote(0.071)];
  await Promise.all(['one', 'two'].map(messageId => app.receive(id, { messageId, supplierId: 's1', text: quoteMessage(DEMO_RFQ, 0.075) })));
  await app.waitForIdle();
  assert.equal(model.maxActive, 1);
  const supplier = (await app.detail(id)).state.suppliers[0];
  assert.equal(supplier.round, 1); assert.equal(supplier.status, 'closed');
  assert.equal((await store.list(`cases/${id}/outbox/`)).filter(k => k.includes('counter-')).length, 1);
});

test('target met still requires matching specs, quantity and all quoted terms', async () => {
  const { app, id, model } = await setup();
  model.responses = [quote(0.065, { grade: '8.8' }), quote(0.065, { quantity: null }), quote(0.065)];
  for (const [index, messageId] of ['mismatch', 'missing', 'good'].entries()) await app.receive(id, { messageId, supplierId: `s${index + 1}`, text: 'TEST ONLY' });
  await app.waitForIdle();
  const detail = await app.detail(id);
  assert.equal(detail.state.suppliers[0].status, 'needs attention');
  assert.equal(detail.state.suppliers[1].status, 'needs attention');
  assert.equal(detail.state.suppliers[2].status, 'target met');
  assert.equal(detail.state.suppliers[2].round, 0);
  assert.match(detail.state.uncertainties.join(' '), /delivery date/);
});

test('description-only RFQ completes research and recovery without fabricated terms or outgoing messages', async () => {
  const store = new MemoryStore(), model = new FakeModel(), events = new Bus();
  const rfq: Rfq = { description: 'Industrial motor, manufacturer part ABC-123', standard: null, size: null, grade: null, finish: null, quantity: null, currency: null, incoterm: null, destination: null, targetUnitPrice: null, maxUnitPrice: null, requiredBy: null };
  const research = { run: async (state: { rfq: Rfq }) => { assert.deepEqual(state.rfq, rfq); return { candidates: [candidate('motor-maker')], uncertainties: [] }; } };
  const app = new Orchestrator({ store, model, events, research });
  const created = await app.create(rfq); await app.start(created.id);
  const detail = await app.detail(created.id);
  assert.deepEqual(detail.state.rfq, rfq); assert.equal(detail.state.researchComplete, true);
  assert.equal(detail.state.status, 'needs attention'); assert.equal(detail.state.error, null);
  assert.match(detail.state.suppliers[0].nextAction, /targetUnitPrice/);
  assert.deepEqual(detail.conversations['motor-maker'], []);
  assert.deepEqual(await store.list(`cases/${created.id}/outbox/`), []);
  await assert.rejects(app.demo(created.id, 'initial-quotes'), (error: any) => error.status === 428);
  const restarted = new Orchestrator({ store, model, events, research }); await restarted.recover(); await restarted.waitForIdle();
  assert.deepEqual((await restarted.detail(created.id)).state.rfq, rfq);
  assert.deepEqual(await store.list(`cases/${created.id}/outbox/`), []); assert.equal(model.jobs.length, 0);
});

test('unknown buyer requirements never produce target-met decisions or counteroffers', async () => {
  const { app, id } = await setup();
  const previous = (await app.detail(id)).state.suppliers[0];
  for (const key of ['standard', 'size', 'grade', 'finish', 'quantity', 'currency', 'incoterm', 'destination', 'targetUnitPrice', 'maxUnitPrice'] as const) {
    for (const price of [0.064, 0.075]) {
      const result = evaluateQuote({ ...DEMO_RFQ, [key]: null }, quote(price), previous);
      assert.equal(result.status, 'needs attention', key); assert.equal(result.counter, false, key);
      assert.ok(result.explanation.includes(key));
    }
  }
});

for (const crashAt of ['decision-saved', 'offer-saved', 'outbox-saved', 'state-saved']) {
  test(`recovery reconciles a crash after ${crashAt} without re-inference or duplicate send`, async () => {
    let failed = false;
    const { app, id, model, store, research, events } = await setup(stage => { if (stage === crashAt && !failed) { failed = true; throw new Error('TEST crash'); } });
    await app.receive(id, { messageId: 'crash-message', supplierId: 's1', text: 'TEST ONLY' }); await app.waitForIdle();
    assert.equal(model.jobs.length, 1);
    const recovered = new Orchestrator({ store, model, research, events });
    await recovered.recover(); await recovered.waitForIdle();
    assert.equal(model.jobs.length, 1);
    const detail = await recovered.detail(id);
    assert.equal(detail.state.suppliers[0].round, 1);
    assert.equal(detail.state.suppliers[0].status, 'negotiating');
    assert.equal(detail.conversations.s1.filter(m => m.messageId.startsWith('counter-')).length, 1);
    assert.equal(detail.conversations.s1.filter(m => m.messageId === 'crash-message').length, 1);
    assert.ok(await store.get(`cases/${id}/processed/crash-message.json`));
    assert.equal((await store.list(`cases/${id}/sent/`)).filter(k => k.includes('counter-')).length, 1);
    await recovered.recover(); await recovered.waitForIdle();
    assert.equal(model.jobs.length, 1);
  });
}

test('recovery scans incoming files absent from case state and preserves inbound-before-ack', async () => {
  const { app, id, model, store, research, events } = await setup();
  const orphan = { messageId: 'durable-unreferenced', caseId: id, supplierId: 's1', text: 'TEST ONLY', direction: 'inbound', simulated: true, createdAt: new Date().toISOString() };
  await store.immutable(`cases/${id}/inbox/incoming/durable-unreferenced.json`, orphan);
  const recovered = new Orchestrator({ store, model, research, events });
  await recovered.recover(); await recovered.waitForIdle();
  assert.equal(model.jobs.length, 1);
  await app.receive(id, { messageId: 'ack-check', supplierId: 's2', text: 'TEST ONLY' });
  assert.ok(await store.get(`cases/${id}/inbox/incoming/ack-check.json`));
  await app.waitForIdle();
});

test('research never fabricates missing supplier identities', async () => {
  const store = new MemoryStore(), model = new FakeModel(), events = new Bus();
  const app = new Orchestrator({ store, model, events, research: { run: async () => ({ candidates: [], uncertainties: [] }) } });
  const state = await app.create();
  await assert.rejects(app.start(state.id), /No evidence-backed/);
  assert.equal((await app.detail(state.id)).state.suppliers.length, 0);
});

test('start/resume retries durable inbox after a transient model failure', async () => {
  const { app, id, model, store } = await setup();
  const original = model.run.bind(model);
  let attempts = 0;
  model.run = async <T>(job: ModelJob): Promise<T> => {
    attempts++;
    if (attempts === 1) throw new Error('TEST ONLY transient model failure');
    return original<T>(job);
  };
  await app.receive(id, { messageId: 'retry-message', supplierId: 's1', text: 'TEST ONLY' });
  await app.waitForIdle();
  assert.equal((await app.detail(id)).state.suppliers[0].status, 'error');
  assert.equal(await store.get(`cases/${id}/processed/retry-message.json`), null);
  await app.start(id); await app.waitForIdle();
  assert.equal(attempts, 2);
  assert.equal((await app.detail(id)).state.suppliers[0].status, 'negotiating');
  assert.ok(await store.get(`cases/${id}/processed/retry-message.json`));
});

test('markRead resets unread without model calls and the next message increments it again', async () => {
  const { app, id, model, store } = await setup();
  await app.receive(id, { messageId: 'unread-first', supplierId: 's1', text: 'TEST ONLY' });
  await app.waitForIdle();
  assert.equal((await app.detail(id)).state.suppliers[0].unread, 1);
  const modelCalls = model.jobs.length;
  assert.equal((await app.markRead(id, 's1')).suppliers[0].unread, 0);
  assert.equal(model.jobs.length, modelCalls);
  assert.equal((await app.detail(id)).events.filter(event => event.type === 'inbox.read').length, 1);
  await app.markRead(id, 's1');
  assert.equal((await app.detail(id)).events.filter(event => event.type === 'inbox.read').length, 1);
  const saved = await store.get<{ suppliers: { unread: number }[] }>(`cases/${id}/state.json`);
  assert.equal(saved!.suppliers[0].unread, 0);
  await app.receive(id, { messageId: 'unread-next', supplierId: 's1', text: 'TEST ONLY next offer' });
  await app.waitForIdle();
  assert.equal((await app.detail(id)).state.suppliers[0].unread, 1);
});

test('markRead during an in-flight model call does not resurrect old unread messages', async () => {
  const { app, id, model } = await setup();
  await app.receive(id, { messageId: 'old-unread', supplierId: 's1', text: 'TEST ONLY' });
  await app.waitForIdle();
  model.delay = 30;
  await app.receive(id, { messageId: 'new-in-flight', supplierId: 's1', text: 'TEST ONLY' });
  while (model.jobs.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  await app.markRead(id, 's1');
  await app.waitForIdle();
  assert.equal((await app.detail(id)).state.suppliers[0].unread, 1);
});

test('replay requires completed English and Chinese snapshots and creates an empty case without changing its source', async () => {
  const { app, id, store, model } = await setup();
  const untouched = await app.create();
  await assert.rejects(app.replay(untouched.id), (error: Error & { status?: number }) => error.status === 409);
  await assert.rejects(app.replay(id), /saved research snapshots/);
  const source = (await app.detail(id)).state;
  const prefix = `cases/${id}/research/${source.researchAttempt}`;
  const english = `${prefix}/english/input/raw_evidence.json`;
  const chinese = `${prefix}/chinese/input/raw_evidence.json`;
  const page = { url: 'https://test.example/', markdown: 'TEST ONLY evidence snapshot' };
  await store.put(english, [page]);
  await assert.rejects(app.replay(id), /saved research snapshots/);
  await store.put(chinese, { incomplete: true });
  await assert.rejects(app.replay(id), /saved research snapshots/);
  await store.put(chinese, [page]);
  await store.put(english, { incomplete: true });
  await assert.rejects(app.replay(id), /saved research snapshots/);
  await store.put(english, [page]);
  source.rfqSource = { id: 'test-source', kind: 'archil', diskId: 'dsk-test', diskName: 'TEST ONLY Scout', path: 'rfqs/test.json', sha256: 'a'.repeat(64), revision: 'test-revision', title: 'TEST ONLY imported RFQ', importedAt: '2026-11-11T00:00:00Z', warnings: ['TEST review warning'], snapshotKey: 'imports/test-source/snapshot.json', snapshotSha256: 'b'.repeat(64) };
  await store.put(`cases/${id}/state.json`, source);
  const sourceBefore = new Map([...store.objects].filter(([key]) => key.startsWith(`cases/${id}/`)).map(([key, value]) => [key, structuredClone(value)]));
  const modelCalls = model.jobs.length;
  const replay = await app.replay(id);
  assert.notEqual(replay.id, id);
  assert.deepEqual(replay.rfq, source.rfq);
  assert.deepEqual(replay.rfqSource, source.rfqSource);
  assert.ok(replay.uncertainties.includes('TEST review warning'));
  assert.equal(replay.status, 'ready');
  assert.equal(replay.researchMode, 'saved research');
  assert.equal(replay.researchComplete, false);
  assert.equal(replay.researchAttempt, null);
  assert.deepEqual(replay.researchReplay, { caseId: id, attemptId: source.researchAttempt });
  assert.deepEqual(replay.suppliers, []);
  const replayDetail = await app.detail(replay.id);
  assert.deepEqual(replayDetail.conversations, {});
  assert.deepEqual(replayDetail.offers, {});
  assert.deepEqual(replayDetail.offerHistory, {});
  assert.equal(model.jobs.length, modelCalls);
  assert.deepEqual(new Map([...store.objects].filter(([key]) => key.startsWith(`cases/${id}/`))), sourceBefore);
});

for (const window of ['inbound conversation', 'outbox record', 'outbound conversation', 'sent receipt', 'processed marker']) {
  test(`recovery repairs failure before ${window} persistence without re-inference or repeated outbound`, async () => {
    const { app, id, model, store, research, events } = await setup();
    store.failBeforeWrite = (key, value) => {
      if (window === 'inbound conversation') return key.endsWith('/conversations/s1.json') && Array.isArray(value) && value.some(m => m.messageId === 'window-test') && !value.some(m => m.messageId.startsWith('counter-'));
      if (window === 'outbox record') return key.includes('/outbox/counter-');
      if (window === 'outbound conversation') return key.endsWith('/conversations/s1.json') && Array.isArray(value) && value.some(m => m.messageId.startsWith('counter-'));
      if (window === 'sent receipt') return key.includes('/sent/counter-');
      return key.endsWith('/processed/window-test.json');
    };
    await app.receive(id, { messageId: 'window-test', supplierId: 's1', text: 'TEST ONLY' });
    await app.waitForIdle();
    assert.equal(model.jobs.length, 1);
    assert.ok(await store.get(`cases/${id}/decisions/window-test.json`));
    const recovered = new Orchestrator({ store, model, research, events });
    await recovered.recover(); await recovered.waitForIdle();
    assert.equal(model.jobs.length, 1);
    const detail = await recovered.detail(id);
    assert.equal(detail.state.suppliers[0].status, 'negotiating');
    assert.equal(detail.conversations.s1.filter(m => m.messageId.startsWith('counter-')).length, 1);
    assert.equal(detail.conversations.s1.filter(m => m.messageId === 'window-test').length, 1);
    assert.equal((await store.list(`cases/${id}/sent/`)).filter(k => k.includes('counter-')).length, 1);
    assert.equal(detail.events.filter(e => e.type === 'message.sent' && String(e.data?.messageId).startsWith('counter-')).length, 1);
    assert.ok(await store.get(`cases/${id}/processed/window-test.json`));
  });
}

test('a lost processed-write acknowledgement does not leave a completed supplier in error', async () => {
  const { app, id, model, store, research, events } = await setup();
  store.failAfterWrite = key => key.endsWith('/processed/committed-message.json');
  await app.receive(id, { messageId: 'committed-message', supplierId: 's1', text: 'TEST ONLY' });
  await app.waitForIdle();
  assert.ok(await store.get(`cases/${id}/processed/committed-message.json`));
  assert.equal((await app.detail(id)).state.suppliers[0].status, 'negotiating');
  const recovered = new Orchestrator({ store, model, research, events });
  await recovered.recover(); await recovered.waitForIdle();
  assert.equal((await recovered.detail(id)).state.suppliers[0].status, 'negotiating');
  assert.equal(model.jobs.length, 1);
});

test('offer history preserves initial and final quotes in receipt order across recovery', async () => {
  const { app, id, model, store, research, events } = await setup();
  model.responses = [quote(0.075), quote(0.064)];
  await app.receive(id, { messageId: 'history-initial', supplierId: 's1', text: 'TEST ONLY initial' });
  await app.receive(id, { messageId: 'history-final', supplierId: 's1', text: 'TEST ONLY final' });
  await app.waitForIdle();
  const before = (await app.detail(id)).offerHistory!.s1;
  assert.deepEqual(before.map(item => item.sourceMessageId), ['history-initial', 'history-final']);
  assert.deepEqual(before.map(item => item.quote.unitPrice), [0.075, 0.064]);
  assert.deepEqual(before.map(item => item.status), ['negotiating', 'target met']);
  assert.ok(before[0].createdAt < before[1].createdAt);
  const recovered = new Orchestrator({ store, model, research, events });
  await recovered.recover(); await recovered.waitForIdle();
  assert.deepEqual((await recovered.detail(id)).offerHistory!.s1, before);
  assert.equal(model.jobs.length, 2);
});

test('live failure reuses only complete saved snapshots for the same RFQ, once',async()=>{
 const {app,id,store,research,events}=await setup();
 const saved=(await app.detail(id)).state;
 for(const track of ['english','chinese'])await store.put(`cases/${id}/research/${saved.researchAttempt}/${track}/input/raw_evidence.json`,[{url:'https://supplier.example.test'}]);
 let calls=0;
 research.run=async(...args:unknown[])=>{calls++;const state=args[0] as {researchMode:string};if(state.researchMode==='live')throw new Error('Search unavailable');return {candidates:[candidate('saved-supplier')],uncertainties:[]};};
 const next=await app.create();await app.start(next.id);
 const result=(await app.detail(next.id)).state;
 assert.equal(calls,2);assert.equal(result.researchMode,'saved research');assert.equal(result.researchReplay?.caseId,id);assert.equal(result.researchComplete,true);assert.ok(events.events.some(e=>e.type==='research.fallback'));
 const different=await app.create({...DEMO_RFQ,quantity:12});await assert.rejects(app.start(different.id),/Search unavailable/);assert.equal(calls,3);
});

test('saved fallback failure stops after one attempt and remains recoverable',async()=>{
 const {app,id,store,research}=await setup();const saved=(await app.detail(id)).state;
 for(const track of ['english','chinese'])await store.put(`cases/${id}/research/${saved.researchAttempt}/${track}/input/raw_evidence.json`,[{}]);
 let calls=0;research.run=async()=>{calls++;throw new Error('Model unavailable');};
 const next=await app.create();await assert.rejects(app.start(next.id),/Model unavailable/);assert.equal(calls,2);assert.equal((await app.detail(next.id)).state.status,'error');
});

test('restart preserves an RFQ sent by an older message template',async()=>{
 const {app,id,store}=await setup();
 for(const supplier of (await app.detail(id)).state.suppliers){
  const sid=supplier.supplier.supplierId;const key=`cases/${id}/outbox/rfq-${id}-${sid}.json`;
  const message=await store.get<any>(key);message.text='Earlier reviewed RFQ wording';await store.put(key,message);
  await store.put(`cases/${id}/conversations/${sid}.json`,[message]);
 }
 const restarted=new Orchestrator({store,model:new FakeModel(),events:new Bus(),research:{run:async()=>{throw new Error('Must not repeat research');}}});
 await restarted.recover();
 const detail=await restarted.detail(id);assert.ok(Object.values(detail.conversations).every(messages=>messages.length===1&&messages[0].text==='Earlier reviewed RFQ wording'));
});
