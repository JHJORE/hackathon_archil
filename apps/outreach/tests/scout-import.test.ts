import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Orchestrator } from '../server/orchestrator.js';
import { DEMO_RFQ } from '../server/fixtures.js';
import type { ScoutItem } from '../shared/scout.js';
import type { CaseState, EventBus, ModelGateway, ResearchPipeline, Rfq, Store } from '../shared/types.js';

class MemoryStore implements Store {
  values = new Map<string, unknown>();
  writes: string[] = [];
  failBefore?: (key: string) => boolean;
  failAfter?: (key: string) => boolean;
  async get<T>(key: string): Promise<T | null> { return this.values.has(key) ? structuredClone(this.values.get(key)) as T : null; }
  async put(key: string, value: unknown) {
    if (this.failBefore?.(key)) { this.failBefore = undefined; throw new Error('TEST storage write interrupted'); }
    this.values.set(key, structuredClone(value)); this.writes.push(key);
    if (this.failAfter?.(key)) { this.failAfter = undefined; throw new Error('TEST write acknowledgement lost'); }
  }
  async putText(key: string, value: string) { await this.put(key, value); }
  async getText(key: string) { return this.get<string>(key); }
  async list(prefix: string) { return [...this.values.keys()].filter(key => key.startsWith(prefix)).sort(); }
  async immutable(key: string, value: unknown) {
    const existing = await this.get(key);
    if (existing !== null) assert.deepEqual(existing, value, `Immutable source changed: ${key}`);
    else await this.put(key, value);
  }
}
const rfq: Rfq = { ...DEMO_RFQ, description: 'Structural steel beam', standard: 'ASTM A992', size: 'W8x18, 20 ft', grade: '50', finish: 'uncoated', quantity: 12, destination: 'Seattle', targetUnitPrice: 300, maxUnitPrice: 400 };
const rawSource = JSON.stringify({ sourceReference: 'SCOUT-TEST-001', buyerNote: 'TEST ONLY source metadata', rfq: { description: rfq.description, quantity: 12 }, unknownField: { preserved: true } }, null, 2);
function itemFor(raw = rawSource): ScoutItem {
  return { id: 'scout-test-one', title: 'TEST ONLY beam RFQ', reference: 'SCOUT-TEST-001', buyer: 'TEST ONLY buyer', dueDate: null, sourceUrl: 'https://example.test/rfq/one', summary: 'TEST ONLY discovery record', rfq: { description: rfq.description, quantity: 12 }, warnings: ['Commercial limits were entered during review.'],
    source: { id: 'scout-test-source', kind: 'archil', diskId: 'dsk-test-read-only', diskName: 'RFQ Scout Test', path: 'rfqs/test-one.json', sha256: createHash('sha256').update(raw).digest('hex'), revision: 'test-revision-1' } };
}
function setup(store = new MemoryStore()) {
  let researchCalls = 0, modelCalls = 0;
  const research: ResearchPipeline = { run: async () => { researchCalls++; throw new Error('Import must not start research'); } };
  const model: ModelGateway = { run: async <T>(): Promise<T> => { modelCalls++; throw new Error('Import must not invoke a model'); } };
  const events: EventBus = { emit: (type, message, data, caseId, supplierId) => ({ id: randomUUID(), at: new Date().toISOString(), type, message, data, caseId, supplierId }) };
  const create = () => new Orchestrator({ store, research, model, events });
  return { store, app: create(), create, calls: () => ({ researchCalls, modelCalls }) };
}

test('repeated and concurrent imports reuse one case without invoking research or models', async () => {
  const { app, store, create, calls } = setup();
  const item = itemFor();
  const results = await Promise.all(Array.from({ length: 8 }, () => app.importRfq(structuredClone(item), rawSource, structuredClone(rfq))));
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  assert.equal((await store.list('cases/')).filter(key => key.endsWith('/state.json')).length, 1);
  assert.equal((await store.list('imports/')).length, 1);
  assert.equal(results[0].status, 'ready'); assert.equal(results[0].researchComplete, false); assert.deepEqual(results[0].suppliers, []);
  const before = structuredClone(await store.get(`cases/${results[0].id}/state.json`));
  const restarted = create();
  const repeated = await restarted.importRfq(item, rawSource, rfq);
  assert.equal(repeated.id, results[0].id); assert.deepEqual(repeated, before);
  assert.deepEqual(calls(), { researchCalls: 0, modelCalls: 0 });
});

test('changed reviewed requirements or source bytes create new cases and retain prior snapshots', async () => {
  const { app, store } = setup();
  const item = itemFor();
  const first = await app.importRfq(item, rawSource, rfq);
  const changedRequirements = await app.importRfq(item, rawSource, { ...rfq, quantity: 24 });
  const newRaw = `${rawSource}\n`;
  const changedSource = await app.importRfq(itemFor(newRaw), newRaw, rfq);
  assert.equal(new Set([first.id, changedRequirements.id, changedSource.id]).size, 3);
  assert.equal((await store.list('imports/')).length, 2);
  assert.equal((await store.get<{ raw: string }>(`imports/${item.id}/${item.source.sha256}.json`))?.raw, rawSource);
  assert.equal((await store.get<CaseState>(`cases/${first.id}/state.json`))?.rfq.quantity, 12);
  assert.equal((await store.get<CaseState>(`cases/${changedRequirements.id}/state.json`))?.rfq.quantity, 24);
});

test('source bytes and warnings are preserved before any runnable case is written', async () => {
  const { app, store } = setup();
  const item = itemFor(), before = structuredClone(item);
  const imported = await app.importRfq(item, rawSource, rfq);
  const sourceKey = `imports/${item.id}/${item.source.sha256}.json`;
  assert.ok(store.writes.indexOf(sourceKey) < store.writes.indexOf(`cases/${imported.id}/rfq.json`));
  assert.ok(store.writes.indexOf(sourceKey) < store.writes.indexOf(`cases/${imported.id}/state.json`));
  assert.deepEqual(await store.get(sourceKey), { source: item.source, raw: rawSource });
  assert.equal(imported.rfqSource?.sha256, item.source.sha256); assert.equal(imported.rfqSource?.path, item.source.path);
  assert.equal(imported.rfqSource?.snapshotKey, sourceKey);
  assert.equal(imported.rfqSource?.snapshotSha256, createHash('sha256').update(rawSource).digest('hex'));
  assert.deepEqual(imported.rfqSource?.warnings, item.warnings); assert.ok(imported.rfqSource?.importedAt);
  assert.ok(imported.uncertainties.includes(item.warnings[0]));
  assert.deepEqual(item, before);
});

for (const boundary of ['source', 'rfq', 'state'] as const) {
  for (const failure of ['before', 'after'] as const) {
    test(`retry after a ${failure}-${boundary} write failure completes the same immutable import`, async () => {
      const { app, store, create } = setup();
      const item = itemFor();
      const matches = (key: string) => boundary === 'source' ? key.startsWith('imports/') : key.endsWith(`/${boundary}.json`);
      if (failure === 'before') store.failBefore = matches; else store.failAfter = matches;
      await assert.rejects(app.importRfq(item, rawSource, rfq), /TEST/);
      const preserved = new Map([...store.values].map(([key, value]) => [key, structuredClone(value)]));
      const restarted = create();
      const completed = await restarted.importRfq(item, rawSource, rfq);
      const repeated = await restarted.importRfq(item, rawSource, rfq);
      assert.equal(completed.id, repeated.id); assert.deepEqual(completed.rfq, rfq);
      assert.equal((await store.list('cases/')).filter(key => key.endsWith('/state.json')).length, 1);
      assert.equal((await store.list('imports/')).length, 1);
      for (const [key, value] of preserved) assert.deepEqual(store.values.get(key), value, `Retry overwrote ${key}`);
    });
  }
}

test('reviewed RFQ unknown fields are stripped and property order does not change import identity', async () => {
  const { app } = setup();
  const first = await app.importRfq(itemFor(), rawSource, rfq);
  const reordered = Object.fromEntries(Object.entries(rfq).reverse());
  const second = await app.importRfq(itemFor(), rawSource, { ...reordered, unreviewedInternalNote: 'must not enter RFQ' } as unknown as Rfq);
  assert.equal(first.id, second.id);
  assert.equal('unreviewedInternalNote' in second.rfq, false);
});

test('omitted requirement keys fail before preserving a runnable import', async () => {
  const { app, store } = setup();
  await assert.rejects(app.importRfq(itemFor(), rawSource, { description: 'Only a vague request' } as Rfq), /RFQ requires/);
  assert.equal(store.values.size, 0);
});

test('explicit unknown source requirements import without inventing quantities, specifications or budget', async () => {
  const { app, store, calls } = setup();
  const unknown: Rfq = { description: 'Manufacturer part ABC-123', standard: null, size: null, grade: null, finish: null, quantity: null, currency: null, incoterm: null, destination: null, targetUnitPrice: null, maxUnitPrice: null, requiredBy: null };
  const imported = await app.importRfq(itemFor(), rawSource, unknown);
  assert.deepEqual(imported.rfq, unknown); assert.equal(imported.status, 'ready');
  assert.ok(imported.uncertainties.some(value => value.includes('targetUnitPrice') && value.includes('quantity')));
  assert.deepEqual(await store.get(`cases/${imported.id}/rfq.json`), unknown);
  assert.deepEqual(calls(), { researchCalls: 0, modelCalls: 0 });
  assert.deepEqual(await store.list(`cases/${imported.id}/outbox/`), []);
});
