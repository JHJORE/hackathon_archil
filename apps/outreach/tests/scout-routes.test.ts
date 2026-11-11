import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express, { type ErrorRequestHandler } from 'express';
import { scoutRoutes } from '../server/scout-routes.js';
import { DEMO_RFQ } from '../server/fixtures.js';
import type { Orchestrator } from '../server/orchestrator.js';
import type { ScoutItem } from '../shared/scout.js';
import type { Rfq } from '../shared/types.js';

const item: ScoutItem = {
  id: 'test-scout-source', title: 'TEST ONLY RFQ', reference: 'TEST-001', buyer: null,
  dueDate: null, sourceUrl: null, summary: 'TEST ONLY source', rfq: { description: 'Part from source' }, warnings: [],
  source: { id: 'test-scout-source', kind: 'archil', diskId: 'dsk-test', diskName: 'TEST ONLY', path: 'rfqs/test.json', sha256: 'a'.repeat(64), revision: null },
};
const body = () => ({ source: { id: item.id, sha256: item.source.sha256 }, rfq: structuredClone(DEMO_RFQ) });

async function setup(t: TestContext) {
  const imports: { item: ScoutItem; raw: string; rfq: Rfq }[] = [];
  const resolutions: string[] = [];
  let current = structuredClone(item), raw = '{"test":"original source"}', readinessError: Error | null = null;
  const app = express();
  app.use(express.json());
  app.use('/api', scoutRoutes({
    ready: () => { if (readinessError) throw readinessError; },
    scout: {
      overview: async () => { throw new Error('Overview must not be read when importing'); },
      resolve: async id => { resolutions.push(id); return { item: structuredClone(current), raw }; },
    },
    orchestrator: { importRfq: async (source: ScoutItem, sourceRaw: string, rfq: Rfq) => {
      imports.push({ item: source, raw: sourceRaw, rfq }); return { id: 'test-imported-case', rfq };
    } } as unknown as Orchestrator,
  }));
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message });
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/scout/import`;
  const post = (payload: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { imports, resolutions, post, url,
    setSource: (next: ScoutItem, sourceRaw: string) => { current = next; raw = sourceRaw; },
    setReadinessError: (error: Error) => { readinessError = error; },
  };
}

test('Scout import revalidates the current source hash before any case write', async t => {
  const { post, imports, resolutions, setSource } = await setup(t);
  const changed = structuredClone(item); changed.source.sha256 = 'b'.repeat(64);
  setSource(changed, '{"test":"new source revision"}');
  const stale = await post(body());
  assert.equal(stale.status, 409); assert.match((await stale.json()).error, /source changed/i);
  assert.deepEqual(resolutions, [item.id]); assert.equal(imports.length, 0);
  const reviewed = body(); reviewed.source.sha256 = changed.source.sha256;
  const accepted = await post(reviewed);
  assert.equal(accepted.status, 201); assert.equal((await accepted.json()).id, 'test-imported-case');
  assert.deepEqual(imports, [{ item: changed, raw: '{"test":"new source revision"}', rfq: DEMO_RFQ }]);
  // A previous successful import does not bypass the next request's source revalidation.
  changed.source.sha256 = 'c'.repeat(64); setSource(changed, '{"test":"third revision"}');
  assert.equal((await post(reviewed)).status, 409); assert.equal(imports.length, 1);
});

test('malformed Scout import requests fail before source reads or case writes', async t => {
  const { post, imports, resolutions, url } = await setup(t);
  const invalidBodies = [null, {}, { ...body(), source: null },
    { ...body(), source: { id: '../escape', sha256: item.source.sha256 } },
    { ...body(), source: { id: item.id, sha256: 'not-a-sha256' } },
    { source: body().source }, { ...body(), rfq: null },
    { ...body(), rfq: { description: 'Incomplete requirements' } },
    { ...body(), rfq: { ...DEMO_RFQ, quantity: 1.5 } },
    { ...body(), rfq: { ...DEMO_RFQ, requiredBy: '2026-02-30' } },
  ];
  for (const payload of invalidBodies) assert.equal((await post(payload)).status, 400, JSON.stringify(payload));
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid' })).status, 400);
  assert.deepEqual(resolutions, []); assert.deepEqual(imports, []);
});

test('Scout import uses server-resolved provenance and strips unreviewed RFQ fields', async t => {
  const { post, imports } = await setup(t);
  const payload = { ...body(), source: { ...body().source, path: 'client-invented.json', diskName: 'client-invented' },
    rfq: { ...DEMO_RFQ, description: '  Reviewed part  ', hiddenInstruction: 'must not enter requirements' },
    raw: 'client supplied replacement source', title: 'client supplied replacement title' };
  assert.equal((await post(payload)).status, 201);
  assert.deepEqual(imports[0].item, item); assert.equal(imports[0].raw, '{"test":"original source"}');
  assert.deepEqual(imports[0].rfq, { ...DEMO_RFQ, description: 'Reviewed part' });
});

test('Scout import readiness failure cannot read the source or persist a case', async t => {
  const { post, imports, resolutions, setReadinessError } = await setup(t);
  setReadinessError(Object.assign(new Error('TEST local store not ready'), { status: 503 }));
  assert.equal((await post(body())).status, 503);
  assert.deepEqual(resolutions, []); assert.deepEqual(imports, []);
});
