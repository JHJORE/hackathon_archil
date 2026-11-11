import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type ErrorRequestHandler } from 'express';
import { localRequestGuard } from '../server/local-request.js';
import { rfqUploadRoutes } from '../server/rfq-upload-routes.js';
import type { RfqUploadService } from '../server/rfq-upload.js';
import type { Orchestrator } from '../server/orchestrator.js';
import type { CaseState, EventBus } from '../shared/types.js';
import { DEMO_RFQ } from '../server/fixtures.js';

function savedCase(id: string): CaseState {
  return {
    id, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', rfq: structuredClone(DEMO_RFQ),
    status: 'ready', suppliers: [], uncertainties: [], holdProcessingMs: 0, researchComplete: false,
    researchAttempt: null, error: null, researchMode: 'live', communicationMode: 'simulated',
  };
}

function researchKey(t: TestContext, value: string | undefined) {
  const previous = process.env.KEENABLE_API_KEY;
  if (value === undefined) delete process.env.KEENABLE_API_KEY;
  else process.env.KEENABLE_API_KEY = value;
  t.after(() => {
    if (previous === undefined) delete process.env.KEENABLE_API_KEY;
    else process.env.KEENABLE_API_KEY = previous;
  });
}

async function setup(t: TestContext) {
  const submissions: { bytes: Buffer; filename: string; mimeType: string }[] = [];
  const imports: { id: string; lineIds: unknown; orchestrator: Orchestrator }[] = [];
  const starts: string[] = [];
  const cases = [savedCase('test-case-1'), savedCase('test-case-2')];
  const orchestrator = { start: async (id: string) => { starts.push(id); } } as unknown as Orchestrator;
  const uploads = {
    submit: async (bytes: Buffer, filename: string, mimeType: string) => {
      submissions.push({ bytes: Buffer.from(bytes), filename, mimeType });
      return { id: 'test-upload', status: 'extracting' };
    },
    importLines: async (id: string, lineIds: unknown, passedOrchestrator: Orchestrator) => {
      imports.push({ id, lineIds, orchestrator: passedOrchestrator });
      return { cases: structuredClone(cases), errors: [] as string[] };
    },
  } as unknown as RfqUploadService;
  let port = 0;
  const app = express();
  // Match production ordering: guard first, JSON parser, then the route's raw parser.
  app.use((req, res, next) => localRequestGuard(port)(req, res, next));
  app.use(express.json());
  const events: EventBus = { emit: (type, message) => ({ id: 'test-event', at: '2026-01-01T00:00:00Z', type, message }) };
  app.use('/api', rfqUploadRoutes({ uploads, orchestrator, events, ready: () => {} }));
  app.post('/api/cases', (req, res) => res.status(201).json({ received: req.body }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.message });
  app.use(errors);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

  const request = (path: string, options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: options.method || 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', ...options.headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: response.statusCode!, body: JSON.parse(text) }); }
        catch { resolve({ status: response.statusCode!, body: text }); }
      });
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(options.body);
  });
  const importLines = (payload: unknown) => request('/api/rfq-uploads/test-upload/import', { body: JSON.stringify(payload) });
  return { request, importLines, submissions, imports, starts, cases, orchestrator, port };
}

test('RFQ upload HTTP route preserves raw PDF/text bytes and decodes the filename', async t => {
  const { request, submissions, port } = await setup(t);
  const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]);
  const text = Buffer.from('TEST ONLY RFQ: 10 screws\n材质待确认', 'utf8');
  for (const [bytes, mimeType, filename] of [
    [pdf, 'application/pdf', 'TEST RFQ 采购.pdf'],
    [text, 'text/plain; charset=utf-8', 'TEST RFQ.txt'],
  ] as const) {
    const result = await request('/api/rfq-uploads', { headers: { 'Content-Type': mimeType, 'X-File-Name': encodeURIComponent(filename), Origin: `http://127.0.0.1:${port}` }, body: bytes });
    assert.equal(result.status, 202);
    assert.deepEqual(result.body, { id: 'test-upload', status: 'extracting' });
    assert.deepEqual(submissions.at(-1), { bytes, filename, mimeType: mimeType.split(';')[0] });
  }
  assert.equal(submissions.length, 2);
});

test('raw-upload exception is limited to the exact POST path; other mutations require JSON', async t => {
  const { request, submissions, imports } = await setup(t);
  for (const [path, method] of [
    ['/api/rfq-uploads/', 'POST'], ['/api/rfq-uploads/test-upload/import', 'POST'],
    ['/api/cases', 'POST'], ['/api/rfq-uploads', 'PATCH'], ['/api/rfq-uploads', 'PUT'],
  ]) {
    const result = await request(path, { method, headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(result.status, 415, `${method} ${path}`);
    assert.match(result.body.error, /require application\/json/i);
  }
  const json = await request('/api/cases', { body: '{"test":"valid JSON mutation"}' });
  assert.equal(json.status, 201);
  assert.deepEqual(json.body.received, { test: 'valid JSON mutation' });
  assert.equal(submissions.length, 0);
  assert.equal(imports.length, 0);
});

test('foreign origins and rebound hosts cannot submit raw documents or import cases', async t => {
  const { request, submissions, imports, port } = await setup(t);
  const rejectedHeaders: Record<string, string>[] = [{ Origin: 'https://foreign.example' }, { Host: `foreign.example:${port}` }, { Origin: 'null' }];
  for (const headers of rejectedHeaders) {
    const upload = await request('/api/rfq-uploads', { headers: { ...headers, 'Content-Type': 'application/pdf', 'X-File-Name': 'TEST.pdf' }, body: '%PDF-test' });
    assert.equal(upload.status, 403);
    const imported = await request('/api/rfq-uploads/test-upload/import', { headers, body: '{"start":false,"lineIds":["one"]}' });
    assert.equal(imported.status, 403);
  }
  assert.equal(submissions.length, 0);
  assert.equal(imports.length, 0);
});

test('unsupported upload MIME types and malformed filenames fail before submitting', async t => {
  const { request, submissions } = await setup(t);
  for (const mimeType of ['application/octet-stream', 'text/html', 'multipart/form-data', 'application/json']) {
    const result = await request('/api/rfq-uploads', { headers: { 'Content-Type': mimeType, 'X-File-Name': 'TEST.pdf' }, body: mimeType === 'application/json' ? '{}' : 'TEST document' });
    assert.equal(result.status, 415, mimeType);
  }
  const invalidName = await request('/api/rfq-uploads', { headers: { 'Content-Type': 'text/plain', 'X-File-Name': '%invalid' }, body: 'TEST document' });
  assert.equal(invalidName.status, 400);
  assert.match(invalidName.body.error, /filename/i);
  assert.equal(submissions.length, 0);
});

test('upload imports require an explicit boolean start flag before any case creation', async t => {
  const { importLines, imports, starts } = await setup(t);
  for (const payload of [null, {}, { lineIds: ['one'] }, { lineIds: ['one'], start: 'true' }, { lineIds: ['one'], start: 0 }]) {
    const result = await importLines(payload);
    assert.equal(result.status, 400);
  }
  assert.equal(imports.length, 0);
  assert.equal(starts.length, 0);
});

test('saving extracted lines returns cases without starting research or requiring a key', async t => {
  researchKey(t, undefined);
  const { importLines, imports, starts, cases, orchestrator } = await setup(t);
  const result = await importLines({ lineIds: ['one', 'two'], start: false });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { cases, errors: [] });
  assert.deepEqual(imports, [{ id: 'test-upload', lineIds: ['one', 'two'], orchestrator }]);
  assert.deepEqual(starts, []);
});

test('start request without a research key returns saved cases and one actionable error', async t => {
  researchKey(t, undefined);
  const { importLines, cases, imports, starts } = await setup(t);
  const result = await importLines({ lineIds: ['one', 'two'], start: true });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body.cases, cases);
  assert.equal(result.body.errors.length, 1);
  assert.match(result.body.errors[0], /RFQ saved.*connect:keenable/i);
  assert.equal(imports.length, 1);
  assert.deepEqual(starts, []);
});

test('explicit start with a research connection queues every returned case', async t => {
  researchKey(t, 'test-only-not-a-real-key');
  const { importLines, starts, cases } = await setup(t);
  const result = await importLines({ lineIds: ['one', 'two'], start: true });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { cases, errors: [] });
  assert.deepEqual(starts, cases.map(state => state.id));
});
