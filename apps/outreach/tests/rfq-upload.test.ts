import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { extractDocumentText, groundExtraction, MAX_UPLOAD_BYTES, RfqUploadService } from '../server/rfq-upload.js';
import { rfqUploadSchema } from '../server/rfq-upload-schema.js';
import { assertStrictSchema, validateOutput } from '../server/schema.js';
import { Orchestrator } from '../server/orchestrator.js';
import type { RfqExtraction, RfqLine, RfqPage, UploadRecord } from '../shared/rfq-upload.js';
import type { EventBus, ModelGateway, ModelJob, Rfq, Store } from '../shared/types.js';

class MemoryStore implements Store {
  values = new Map<string, unknown>();
  timeline: string[] = [];
  failBefore?: (key: string, value: any) => boolean;
  failAfter?: (key: string, value: any) => boolean;
  async get<T>(key: string): Promise<T | null> { return this.values.has(key) ? structuredClone(this.values.get(key)) as T : null; }
  async put(key: string, value: unknown) {
    if (this.failBefore?.(key, value)) { this.failBefore = undefined; throw new Error('TEST interrupted write'); }
    this.values.set(key, structuredClone(value)); this.timeline.push(key);
    if (this.failAfter?.(key, value)) { this.failAfter = undefined; throw new Error('TEST lost write acknowledgement'); }
  }
  async putText(key: string, value: string) { await this.put(key, value); }
  async getText(key: string) { return this.get<string>(key); }
  async list(prefix: string) { return [...this.values.keys()].filter(key => key.startsWith(prefix)).sort(); }
  async immutable(key: string, value: unknown) {
    if (this.values.has(key)) assert.deepEqual(this.values.get(key), value, `Immutable conflict: ${key}`);
    else await this.put(key, value);
  }
}
const events: EventBus = { emit: (type, message, data, caseId, supplierId) => ({ id: randomUUID(), at: new Date().toISOString(), type, message, data, caseId, supplierId }) };
const sourceText = 'TEST RFQ\nMotor ABC-123: quantity 12 each.\nQuote currency USD.\nNo substitutions without written approval.';
const sourceBytes = new TextEncoder().encode(sourceText);
const pages: RfqPage[] = [{ page: 1, text: sourceText }];
const unknownRfq = (description: string): Rfq => ({ description, standard: null, size: null, grade: null, finish: null, quantity: null, currency: null, incoterm: null, destination: null, targetUnitPrice: null, maxUnitPrice: null, requiredBy: null });
function line(description = 'Motor ABC-123', overrides: Partial<Rfq> = {}, evidence?: RfqLine['evidence'], unit: string | null = 'each'): RfqLine {
  return { lineId: 'model-chosen-id', rfq: { ...unknownRfq(description), quantity: 12, currency: 'USD', ...overrides }, unit,
    evidence: evidence ?? [
      { field: 'description', quote: 'Motor ABC-123: quantity 12 each.', page: 1 },
      { field: 'quantity', quote: 'Motor ABC-123: quantity 12 each.', page: 1 },
      { field: 'currency', quote: 'Quote currency USD.', page: 1 },
    ], uncertainties: [] };
}
function extraction(lines = [line()]): RfqExtraction {
  return { title: 'TEST RFQ', reference: null, buyer: null, quoteDueDate: null, lines, requirements: ['No substitutions without written approval.'], warnings: [] };
}
function setup(options: { store?: MemoryStore; output?: RfqExtraction; parsedPages?: RfqPage[]; beforeModel?: (job: ModelJob) => Promise<void> } = {}) {
  const store = options.store ?? new MemoryStore(), jobs: ModelJob[] = [];
  let parses = 0;
  const model: ModelGateway = { run: async <T>(job: ModelJob): Promise<T> => {
    jobs.push(job); store.timeline.push('model'); await options.beforeModel?.(job);
    return structuredClone(options.output ?? extraction()) as T;
  } };
  const parse = async () => { parses++; store.timeline.push('parse'); return structuredClone(options.parsedPages ?? pages); };
  const make = () => new RfqUploadService({ store, model, events, parse });
  return { service: make(), make, store, jobs, model, parses: () => parses };
}

test('upload schema is strict and rejects omitted or invented model fields', () => {
  assert.doesNotThrow(() => assertStrictSchema(rfqUploadSchema));
  assert.doesNotThrow(() => validateOutput(rfqUploadSchema, extraction()));
  const missing = extraction(); delete (missing.lines[0].rfq as Partial<Rfq>).grade;
  assert.throws(() => validateOutput(rfqUploadSchema, missing), /Invalid structured output/);
  assert.throws(() => validateOutput(rfqUploadSchema, { ...extraction(), secretInstruction: 'unsupported' }), /Invalid structured output/);
});

test('upload acknowledgement follows durable source and receipt; saved pages precede the extraction model', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const called = new Promise<void>(resolve => { entered = resolve; });
  const h = setup({ beforeModel: async job => {
    assert.deepEqual((job.input as { pages: RfqPage[] }).pages, pages);
    assert.equal(job.priority, 2);
    assert.ok([...h.store.values.keys()].some(key => key.endsWith('/source.json')));
    assert.ok([...h.store.values.keys()].some(key => key.endsWith('/pages.json')));
    entered(); await gate;
  } });
  const receipt = await h.service.submit(sourceBytes, 'rfq.txt', 'text/plain');
  const base = `rfq-uploads/${receipt.id}`;
  h.store.timeline.push('ack');
  assert.equal(receipt.status, 'extracting');
  const source = await h.service.document(receipt.id);
  assert.equal(source.base64, Buffer.from(sourceBytes).toString('base64'));
  assert.equal(source.sha256, createHash('sha256').update(sourceBytes).digest('hex'));
  assert.ok(await h.store.get(`${base}/receipt.json`));
  assert.ok(h.store.timeline.indexOf(`${base}/source.json`) < h.store.timeline.indexOf('ack'));
  await called;
  assert.ok(h.store.timeline.indexOf(`${base}/source.json`) < h.store.timeline.indexOf('parse'));
  assert.ok(h.store.timeline.indexOf(`${base}/pages.json`) < h.store.timeline.indexOf('model'));
  release(); await h.service.waitForIdle();
  const ready = await h.service.get(receipt.id);
  assert.equal(ready.status, 'ready'); assert.equal(ready.pages, 1);
  assert.deepEqual(ready.result, await h.store.get(`${base}/extraction.json`));
});

test('unsupported fields and metadata are removed while literal requirements and part IDs survive', () => {
  const invented = extraction();
  invented.title = 'Invented project'; invented.buyer = 'Invented buyer';
  invented.requirements.push('Supplier must provide an invented certification.');
  invented.lines[0].rfq.grade = '12.9'; invented.lines[0].rfq.finish = 'black oxide';
  invented.lines[0].evidence.push({ field: 'grade', quote: 'Motor ABC-123: quantity 12 each.', page: 1 }, { field: 'finish', quote: 'Finish black oxide.', page: 1 });
  const grounded = groundExtraction(invented, pages);
  assert.equal(grounded.lines[0].rfq.description, 'Motor ABC-123');
  assert.equal(grounded.lines[0].rfq.grade, null); assert.equal(grounded.lines[0].rfq.finish, null);
  assert.equal(grounded.title, null); assert.equal(grounded.buyer, null);
  assert.deepEqual(grounded.requirements, ['No substitutions without written approval.']);
  assert.ok(grounded.lines[0].uncertainties.some(value => value.includes('grade')));
  assert.equal(invented.lines[0].rfq.grade, '12.9', 'grounding must not mutate the model output');
  const unsupportedDescription = extraction([line('Fabricated product')]);
  assert.throws(() => groundExtraction(unsupportedDescription, pages), /No line items could be grounded/);
});

test('historical award prices are never promoted to target or maximum buyer budgets', () => {
  for (const history of ['Previous award unit price USD 3.5 per piece.', 'Previous maximum award unit price USD 3.5 per piece.', 'Maximum award unit price USD 3.5 per piece.']) {
    const input = extraction([line('Motor ABC-123', { targetUnitPrice: 3.5, maxUnitPrice: 3.5 })]);
    input.lines[0].evidence.push({ field: 'targetUnitPrice', quote: history, page: 1 }, { field: 'maxUnitPrice', quote: history, page: 1 });
    const grounded = groundExtraction(input, [{ page: 1, text: `${sourceText}\n${history}` }]);
    assert.equal(grounded.lines[0].rfq.targetUnitPrice, null, history);
    assert.equal(grounded.lines[0].rfq.maxUnitPrice, null, history);
  }
  const target = 'Buyer target unit price USD 3.5 per piece.', ceiling = 'Buyer maximum unit price USD 4.5 per piece.';
  const input = extraction([line('Motor ABC-123', { targetUnitPrice: 3.5, maxUnitPrice: 4.5 })]);
  input.lines[0].evidence.push({ field: 'targetUnitPrice', quote: target, page: 1 }, { field: 'maxUnitPrice', quote: ceiling, page: 1 });
  const grounded = groundExtraction(input, [{ page: 1, text: `${sourceText}\n${target}\n${ceiling}` }]);
  assert.equal(grounded.lines[0].rfq.targetUnitPrice, 3.5); assert.equal(grounded.lines[0].rfq.maxUnitPrice, 4.5);
});

test('price grounding accepts equivalent decimals and punctuation but refuses numeric suffixes or total budgets', () => {
  for (const [price, expected] of [['3.50.', 3.5], ['3.5.', 3.5], ['13.5.', null], ['3.51.', null]] as const) {
    const quote = `Buyer target unit price USD ${price}`;
    const input = extraction([line('Motor ABC-123', { targetUnitPrice: 3.5 })]);
    input.lines[0].evidence.push({ field: 'targetUnitPrice', quote, page: 1 });
    assert.equal(groundExtraction(input, [{ page: 1, text: `${sourceText}\n${quote}` }]).lines[0].rfq.targetUnitPrice, expected, quote);
  }
  const total = 'Buyer maximum total contract budget USD 3.5.';
  const input = extraction([line('Motor ABC-123', { maxUnitPrice: 3.5 })]);
  input.lines[0].evidence.push({ field: 'maxUnitPrice', quote: total, page: 1 });
  assert.equal(groundExtraction(input, [{ page: 1, text: `${sourceText}\n${total}` }]).lines[0].rfq.maxUnitPrice, null);
});

test('bid closing dates cannot become delivery dates and invented quotation deadlines are cleared', () => {
  const closing = 'Quotations must be received by 2026 NOV 12.', delivery = 'Required delivery date: 26 May 2027.';
  const captured = [{ page: 1, text: `${sourceText}\n${closing}\n${delivery}` }];
  const input = extraction([line('Motor ABC-123', { requiredBy: '2026-11-12' })]);
  input.quoteDueDate = '2026-11-12'; input.lines[0].evidence.push({ field: 'requiredBy', quote: closing, page: 1 });
  const grounded = groundExtraction(input, captured);
  assert.equal(grounded.lines[0].rfq.requiredBy, null); assert.equal(grounded.quoteDueDate, '2026-11-12');
  input.lines[0].rfq.requiredBy = '2027-05-26'; input.lines[0].evidence = input.lines[0].evidence.filter(item => item.field !== 'requiredBy');
  input.lines[0].evidence.push({ field: 'requiredBy', quote: delivery, page: 1 });
  assert.equal(groundExtraction(input, captured).lines[0].rfq.requiredBy, '2027-05-26');
  for (const invented of ['2030-01-01', '2027-05-26', '2026-02-30']) {
    input.quoteDueDate = invented;
    assert.equal(groundExtraction(input, captured).quoteDueDate, null, invented);
  }
});

test('separate line items receive distinct stable IDs and bulk or unknown quantities stay unresolved', () => {
  const steel = 'Steel stock XYZ-456: quantity 50 kg.';
  const input = extraction([line(), line('Steel stock XYZ-456', { quantity: 50, currency: null }, [
    { field: 'description', quote: steel, page: 2 }, { field: 'quantity', quote: steel, page: 2 },
  ], 'kg'), line('Steel stock XYZ-456', { quantity: 50, currency: null }, [{ field: 'description', quote: steel, page: 2 }, { field: 'quantity', quote: steel, page: 2 }], null)]);
  const grounded = groundExtraction(input, [...pages, { page: 2, text: steel }]);
  assert.deepEqual(grounded.lines.map(value => value.lineId), ['line-1', 'line-2', 'line-3']);
  assert.deepEqual(grounded.lines.map(value => value.rfq.quantity), [12, null, null]);
  assert.equal(grounded.lines[1].unit, 'kg'); assert.equal(grounded.lines[2].unit, null);
});

test('a model-invented each unit cannot turn kilograms into a piece quantity', () => {
  const source = 'Steel stock XYZ-456: quantity 50 kg.';
  const input = extraction([line('Steel stock XYZ-456', { quantity: 50, currency: null }, [
    { field: 'description', quote: source, page: 1 }, { field: 'quantity', quote: source, page: 1 },
  ], 'each')]);
  const grounded = groundExtraction(input, [{ page: 1, text: source }]);
  assert.equal(grounded.lines[0].rfq.quantity, null);
  assert.equal(grounded.lines[0].unit, null);
});

test('repeated and concurrent selected-line imports reuse cases without starting agents or changing source bytes', async () => {
  const steel = 'Steel stock XYZ-456: quantity 50 kg.';
  const h = setup({ output: extraction([line(), line('Steel stock XYZ-456', { quantity: 50, currency: null }, [{ field: 'description', quote: steel, page: 2 }, { field: 'quantity', quote: steel, page: 2 }], 'kg')]), parsedPages: [...pages, { page: 2, text: steel }] });
  const upload = await h.service.submit(sourceBytes, 'rfq.txt', 'text/plain'); await h.service.waitForIdle();
  let researchCalls = 0;
  const orchestrator = new Orchestrator({ store: h.store, model: h.model, events, research: { run: async () => { researchCalls++; throw new Error('Import must not start research'); } } });
  const original = await h.service.document(upload.id);
  const results = await Promise.all(Array.from({ length: 4 }, () => h.service.importLines(upload.id, ['line-1', 'line-2'], orchestrator)));
  assert.ok(results.every(result => result.errors.length === 0));
  assert.equal(new Set(results.flatMap(result => result.cases.map(value => value.id))).size, 2);
  assert.equal((await h.store.list('cases/')).filter(key => key.endsWith('/state.json')).length, 2);
  assert.equal(results[0].cases[0].rfq.quantity, 12); assert.equal(results[0].cases[1].rfq.quantity, null);
  assert.ok(results[0].cases.every(value => value.status === 'ready' && value.rfqSource?.sha256 === original.sha256));
  assert.deepEqual(await h.service.document(upload.id), original);
  assert.equal(h.jobs.length, 1); assert.equal(researchCalls, 0);
  const before = structuredClone(h.store.values);
  await assert.rejects(h.service.importLines(upload.id, ['line-1', 'line-1'], orchestrator), /distinct/);
  await assert.rejects(h.service.importLines(upload.id, ['missing-line'], orchestrator), /not found/);
  assert.deepEqual(h.store.values, before);
});

for (const window of ['before-ready-state', 'after-extraction', 'after-ready-state'] as const) {
  test(`recovery after ${window} restores the saved extraction without another model or parse`, async () => {
    const h = setup();
    if (window === 'before-ready-state') h.store.failBefore = (key, value) => key.endsWith('/state.json') && value.status === 'ready';
    else if (window === 'after-extraction') h.store.failAfter = key => key.endsWith('/extraction.json');
    else h.store.failAfter = (key, value) => key.endsWith('/state.json') && value.status === 'ready';
    const upload = await h.service.submit(sourceBytes, 'rfq.txt', 'text/plain'); await h.service.waitForIdle();
    const result = await h.store.get<RfqExtraction>(`rfq-uploads/${upload.id}/extraction.json`);
    assert.ok(result); assert.equal(h.jobs.length, 1);
    const restarted = h.make(); await restarted.recover(); await restarted.waitForIdle();
    const recovered = await restarted.get(upload.id);
    assert.equal(recovered.status, 'ready'); assert.deepEqual(recovered.result, result);
    assert.equal(h.jobs.length, 1); assert.equal(h.parses(), 1);
  });
}

test('a durable upload receipt recovers a failed initial state write before acknowledgement', async () => {
  const h = setup(); h.store.failBefore = key => key.endsWith('/state.json');
  await assert.rejects(h.service.submit(sourceBytes, 'rfq.txt', 'text/plain'), /TEST interrupted/);
  assert.equal(h.jobs.length, 0); assert.equal(h.parses(), 0);
  const receiptKey = (await h.store.list('rfq-uploads/')).find(key => key.endsWith('/receipt.json'))!;
  const receipt = await h.store.get<UploadRecord>(receiptKey); assert.ok(receipt);
  const restarted = h.make(); await restarted.recover(); await restarted.waitForIdle();
  assert.equal((await restarted.get(receipt.id)).status, 'ready');
  assert.equal(h.jobs.length, 1); assert.equal(h.parses(), 1);
});

test('invalid MIME, size, PDF header and filename are rejected before any write or parser call', async () => {
  const h = setup();
  const invalid: Array<[Uint8Array, string, string, number]> = [
    [sourceBytes, 'rfq.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 415],
    [new Uint8Array(), 'rfq.txt', 'text/plain', 413], [new Uint8Array(MAX_UPLOAD_BYTES + 1), 'rfq.txt', 'text/plain', 413],
    [sourceBytes, 'rfq.pdf', 'application/pdf', 400],
    ...['../rfq.txt', 'path\\rfq.txt', 'rfq\n.txt', 'rfq\0.txt', '', '   ', 'x'.repeat(181)].map(filename => [sourceBytes, filename, 'text/plain', 400] as [Uint8Array, string, string, number]),
  ];
  for (const [bytes, filename, mimeType, status] of invalid) await assert.rejects(h.service.submit(bytes, filename, mimeType), (error: any) => error.status === status, filename || 'empty');
  assert.equal(h.store.values.size, 0); assert.equal(h.parses(), 0); assert.equal(h.jobs.length, 0);
});

test('UTF-8 text parser preserves multilingual content and rejects malformed, binary, blank and oversized text', async () => {
  const text = '询价单\n电机型号 ABC-123 — quantity 12 each.\nPlease quote; no order is placed.';
  assert.deepEqual(await extractDocumentText(new TextEncoder().encode(text), 'text/plain'), [{ page: 1, text }]);
  for (const bytes of [new Uint8Array([0xc3, 0x28]), new TextEncoder().encode('binary\0data'), new TextEncoder().encode(' \n\t'), new TextEncoder().encode('a'.repeat(400001))]) {
    await assert.rejects(extractDocumentText(bytes, 'text/plain'), (error: any) => error.status === 400);
  }
});
