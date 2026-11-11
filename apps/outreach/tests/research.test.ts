import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchQuery, KeenableResearchClient, ResearchService } from '../server/research.js';
import { EXCLUDED_DOMAINS, verifyCandidates } from '../server/grounding.js';
import { researchSynthesisSchema, evaluatorSchema } from '../server/research-schemas.js';
import { assertStrictSchema } from '../server/schema.js';
import { DEMO_RFQ } from '../server/fixtures.js';
import type { CandidateDraft, CaseState, EvidencePage, ExecJob, ModelJob, Rfq, Store, EventBus } from '../shared/types.js';

class MemoryStore implements Store {
  readonly values = new Map<string, string>();
  async get<T>(key: string) { const value = this.values.get(key); return value === undefined ? null : JSON.parse(value) as T; }
  async put(key: string, value: unknown) { this.values.set(key, JSON.stringify(value)); }
  async putText(key: string, text: string) { this.values.set(key, text); }
  async getText(key: string) { return this.values.get(key) ?? null; }
  async list(prefix: string) { return [...this.values.keys()].filter(key => key.startsWith(prefix)); }
  async immutable(key: string, value: unknown) { assert.equal(this.values.has(key), false); await this.put(key, value); }
}
const events: EventBus = { emit: (type, message, data, caseId, supplierId) => ({ id: type, at: new Date().toISOString(), type, message, data, caseId, supplierId }) };
const state: CaseState = { id: 'case-test', createdAt: '', updatedAt: '', rfq: DEMO_RFQ, status: 'researching', suppliers: [], uncertainties: [], holdProcessingMs: 0,
  researchComplete: false, researchAttempt: 'attempt-one', error: null, researchMode: 'live' };
const raw = 'Acme Fasteners Co. Ltd. manufactures socket head cap screws. ISO 4762 M8x30 grade 12.9 black oxide. Email sales@acme-fasteners.com. Phone +86 138 0013 8000.';
const finalUrl = 'https://www.acme-fasteners.com/product';
const draft: CandidateDraft = { companyName: 'Acme Fasteners Co. Ltd.', chineseName: null, city: null, sourceUrl: finalUrl,
  publishedContacts: { emails: ['sales@acme-fasteners.com'], phones: ['+8613800138000'] }, technicalFit: { score: 90, summary: 'Tentative fit', standards: ['ISO 4762'], grades: ['12.9'], finish: 'black oxide' },
  manufacturingEvidence: ['manufactures socket head cap screws.'], certifications: [], identifiers: { uscc: null, icp: null },
  evidenceQuotes: [{ url: finalUrl, text: 'manufactures socket head cap screws.', claim: 'manufactures socket head cap screws.' }], uncertainties: [] };

test('research schemas satisfy strict structured-output requirements', () => {
  assert.doesNotThrow(() => assertStrictSchema(researchSynthesisSchema));
  assert.doesNotThrow(() => assertStrictSchema(evaluatorSchema));
});

test('RFQ-specific discovery preserves default screw enrichment without imposing it on other products', () => {
  const english = buildResearchQuery(DEMO_RFQ, 'english');
  const chinese = buildResearchQuery(DEMO_RFQ, 'chinese');
  for (const term of ['ISO 4762', 'M8x30', '12.9', 'black oxide', '50000', 'USD', 'CIF', 'Oakland']) {
    assert.ok(english.includes(term), `English query preserves ${term}`);
    assert.ok(chinese.includes(term), `Chinese query preserves ${term}`);
  }
  for (const term of ['DIN912', 'socket head cap screws', 'cold heading', 'heat treatment', 'export']) assert.ok(english.includes(term));
  for (const term of ['12.9级', '内六角圆柱头螺钉', 'ISO4762', '生产厂家', '紧固件', '海盐', '宁波', '永年', '嘉善']) assert.ok(chinese.includes(term));

  const otherProducts: Rfq[] = [
    { ...DEMO_RFQ, description: 'Structural steel beam with bolt holes', standard: 'EN 10025-2', size: 'HEA 200 x 6 m', grade: 'S355JR', finish: 'hot dip galvanized', quantity: 12, currency: 'EUR', incoterm: 'DAP', destination: 'Bergen, Norway', requiredBy: '2027-02-15' },
    { ...DEMO_RFQ, description: 'Extruded aluminum enclosure', standard: 'EN 755-9', size: '180 x 100 x 40 mm', grade: '6063-T6', finish: 'clear anodized', quantity: 240, currency: 'EUR', incoterm: 'FOB', destination: 'Shanghai', requiredBy: null },
  ];
  for (const rfq of otherProducts) {
    const before = structuredClone(rfq);
    for (const track of ['english', 'chinese'] as const) {
      const query = buildResearchQuery(Object.freeze(rfq), track);
      for (const term of [rfq.description, rfq.standard, rfq.size, rfq.grade, rfq.finish, String(rfq.quantity), rfq.currency, rfq.incoterm, rfq.destination, ...(rfq.requiredBy ? [rfq.requiredBy] : [])].filter((value): value is string => value !== null)) assert.ok(query.includes(term), `${track} query preserves ${term}`);
      assert.doesNotMatch(query, /DIN912|ISO4762|ISO 4762|M8x30|12\.9|socket head cap|cold heading|heat treatment|紧固件|内六角|冷镦|热处理|海盐|宁波|永年|嘉善/i);
    }
    assert.deepEqual(rfq, before);
  }
});

test('description and part identifiers can drive both research tracks without invented missing requirements', () => {
  const rfq: Rfq = { description: 'Industrial motor manufacturer part ABC-123', standard: null, size: null, grade: null, finish: null, quantity: null, currency: null, incoterm: null, destination: null, targetUnitPrice: null, maxUnitPrice: null, requiredBy: null };
  const before = structuredClone(rfq);
  for (const track of ['english', 'chinese'] as const) {
    const query = buildResearchQuery(rfq, track);
    assert.ok(query.includes(rfq.description));
    assert.doesNotMatch(query, /\b(?:null|undefined|USD|CIF|Oakland|50000|quantity|DIN912)\b|采购数量|报价币种|交货条款|紧固件/i);
    const partlyKnown = buildResearchQuery({ ...rfq, standard: 'IEC 60034', quantity: 8, destination: 'Seattle' }, track);
    for (const term of ['ABC-123', 'IEC 60034', '8', 'Seattle']) assert.ok(partlyKnown.includes(term));
    assert.doesNotMatch(partlyKnown, /\b(?:null|undefined|USD|CIF|Oakland)\b/i);
  }
  assert.deepEqual(rfq, before);
});

test('custom steel RFQ drives both live search tracks and saved/model inputs without fastener defaults', async () => {
  const previous = process.env.KEENABLE_API_KEY; process.env.KEENABLE_API_KEY = 'test-only-custom-rfq';
  const store = new MemoryStore();
  const rfq: Rfq = Object.freeze({ description: 'Structural steel beam', standard: 'ASTM A36', size: 'W8x18 length 20 ft', grade: 'A36', finish: 'shop primer', quantity: 16, currency: 'USD', incoterm: 'CIF', destination: 'Seattle', targetUnitPrice: 250, maxUnitPrice: 320, requiredBy: '2027-03-01' });
  const customState: CaseState = { ...state, id: 'steel-case', rfq };
  const before = structuredClone(customState);
  const queries: string[] = [];
  let modelCalls = 0, execCalls = 0;
  try {
    const service = new ResearchService({ store, events, diskId: 'dsk-test', verifierBundle: '// TEST ONLY', sleep: async () => {}, onUsage: () => {}, onExec: () => {},
      transport: (async (url, init) => {
        assert.ok(new URL(String(url)).pathname.endsWith('/search'));
        const body = JSON.parse(init!.body as string);
        assert.deepEqual(body.exclude_domains, EXCLUDED_DOMAINS);
        assert.equal(body.max_results, 5);
        queries.push(body.query);
        return Response.json({ results: [] });
      }) as typeof fetch,
      model: { async run<T>(job: ModelJob): Promise<T> {
        modelCalls++;
        assert.deepEqual((job.input as { rfq: Rfq }).rfq, rfq);
        assert.ok(job.kind.endsWith('sourcing'));
        return { candidates: [], uncertainties: ['TEST ONLY empty search results'] } as T;
      } },
      execute: async options => {
        execCalls++;
        const mounts = options.disks as Record<string, { subdirectory: string }>;
        const input = mounts.input!.subdirectory.replace('autonomous-sourcing/v1/', '');
        const output = mounts.output!.subdirectory.replace('autonomous-sourcing/v1/', '');
        assert.deepEqual(await store.get(`${input}/rfq.json`), rfq);
        await store.put(`${output}/verified.json`, { candidates: [], uncertainties: [], rejected: [] });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const result = await service.run(customState);
    assert.equal(queries.length, 2); assert.equal(modelCalls, 2); assert.equal(execCalls, 2);
    assert.deepEqual(result.candidates, []);
    for (const query of queries) {
      for (const term of ['Structural steel beam', 'ASTM A36', 'W8x18 length 20 ft', 'A36', 'shop primer', '16', 'USD', 'CIF', 'Seattle', '2027-03-01']) assert.ok(query.includes(term));
      assert.doesNotMatch(query, /fastener|DIN912|ISO4762|socket head cap|12\.9|M8x30|紧固件|内六角|海盐|宁波|永年|嘉善/i);
    }
    assert.ok(queries.some(query => query.includes('Official Chinese')));
    assert.ok(queries.some(query => query.includes('中国') && query.includes('采购数量')));
    for (const track of ['english', 'chinese']) {
      const saved = await store.get<{ query: string }>(`cases/steel-case/research/attempt-one/${track}/search.json`);
      assert.equal(saved?.query, buildResearchQuery(rfq, track as 'english' | 'chinese'));
    }
    assert.deepEqual(customState, before);
  } finally { if (previous === undefined) delete process.env.KEENABLE_API_KEY; else process.env.KEENABLE_API_KEY = previous; }
});

test('missing key fails visibly; key is refreshed per request and 402 is not retried', async () => {
  const previous = process.env.KEENABLE_API_KEY;
  const observed: string[] = []; let calls = 0;
  const transport = (async (_url, init) => {
    calls++; observed.push(new Headers(init?.headers).get('X-API-Key')!);
    return Response.json({ content: raw, url: finalUrl }, { status: calls === 2 ? 402 : 200 });
  }) as typeof fetch;
  const client = new KeenableResearchClient(() => {}, transport, async () => {});
  try {
    delete process.env.KEENABLE_API_KEY;
    await assert.rejects(client.fetchPage(finalUrl, false), /KEENABLE_API_KEY is missing/);
    assert.equal(calls, 0);
    process.env.KEENABLE_API_KEY = 'test-only-first'; await client.fetchPage(finalUrl, false);
    process.env.KEENABLE_API_KEY = 'test-only-second'; await assert.rejects(client.fetchPage(finalUrl, false), /Credits exhausted/);
    assert.deepEqual(observed, ['test-only-first', 'test-only-second']); assert.equal(calls, 2);
  } finally { if (previous === undefined) delete process.env.KEENABLE_API_KEY; else process.env.KEENABLE_API_KEY = previous; }
});

test('pipeline persists both tracks before synthesis, runs two scoped execs and limits evaluator to known suppliers', async () => {
  const previous = process.env.KEENABLE_API_KEY; process.env.KEENABLE_API_KEY = 'test-only-key';
  const store = new MemoryStore();
  const requests: { url: URL; init?: RequestInit }[] = [];
  const usage: { kind: string; credits: number }[] = [];
  const jobs: ExecJob[] = [];
  let active = 0, peak = 0, executionCount = 0;
  const activePages = new Map<string, number>(); let peakPages = 0;
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const transport = (async (url, init) => {
    const parsed = new URL(String(url)); requests.push({ url: parsed, init });
    if (parsed.pathname.endsWith('/search')) return Response.json({ results: [
      { title: 'Acme', url: 'http://acme-fasteners.com/product', snippet: 'not grounding evidence' },
      { title: 'Duplicate fragment', url: 'http://acme-fasteners.com/product#spec', snippet: '' },
      { title: 'Contact', url: 'http://acme-fasteners.com/contact', snippet: '' },
    ], usage: { credits: 1 } });
    const requestedUrl = parsed.searchParams.get('url')!;
    activePages.set(requestedUrl, (activePages.get(requestedUrl) ?? 0) + 1); peakPages = Math.max(peakPages, activePages.size);
    await new Promise(resolve => setImmediate(resolve));
    const remaining = activePages.get(requestedUrl)! - 1;
    if (remaining) activePages.set(requestedUrl, remaining); else activePages.delete(requestedUrl);
    return Response.json({ url: requestedUrl.includes('/contact') ? finalUrl.replace('/product', '/contact') : finalUrl,
      title: 'Acme', content: parsed.searchParams.has('prompt') ? 'Extraction says sales@hallucinated.com' : raw, truncated: false, usage: { credits: 2 } });
  }) as typeof fetch;
  const model = { async run<T>(job: ModelJob): Promise<T> {
    assert.equal(job.priority, 2);
    if (job.kind.endsWith('sourcing')) {
      assert.equal((await store.list('cases/case-test/research/attempt-one/')).filter(path => path.endsWith('raw_evidence.json')).length, 2);
      return { candidates: [structuredClone(draft)], uncertainties: [] } as T;
    }
    const candidates = (job.input as { candidates: { supplierId: string }[] }).candidates;
    return { selectedSupplierIds: [candidates[0]!.supplierId, 'invented-id'], uncertainties: ['MOQ still unknown.'] } as T;
  } };
  try {
    const service = new ResearchService({ store, model, events, diskId: 'dsk-test', storagePrefix: 'autonomous-sourcing/v1/',
      transport, sleep: async () => {}, verifierBundle: '// test fixture bundle', onUsage: (kind, credits) => usage.push({ kind, credits }), onExec: job => jobs.push(job),
      execute: async options => {
        active++; peak = Math.max(peak, active); executionCount++;
        if (executionCount === 2) release(); await barrier;
        const mounts = options.disks as Record<string, { disk: string; subdirectory: string; readOnly?: boolean; conditional?: boolean }>;
        assert.equal(mounts.scripts?.readOnly, true); assert.equal(mounts.input?.readOnly, true); assert.equal(mounts.output?.conditional, true);
        assert.equal(mounts.output?.disk, 'dsk-test'); assert.ok(!('diskId' in mounts.output!));
        assert.equal(options.command, 'node /mnt/archil/scripts/verify.mjs /mnt/archil/input /mnt/archil/output');
        const input = mounts.input!.subdirectory.replace('autonomous-sourcing/v1/', '');
        const output = mounts.output!.subdirectory.replace('autonomous-sourcing/v1/', '');
        const candidates = await store.get<CandidateDraft[]>(`${input}/candidate_drafts.json`);
        const pages = await store.get<EvidencePage[]>(`${input}/raw_evidence.json`);
        await store.put(`${output}/verified.json`, verifyCandidates(candidates!, pages!, DEMO_RFQ));
        active--; return { exitCode: 0, stdout: '', stderr: '' };
      } });
    const result = await service.run(state);
    assert.equal(peak, 2); assert.equal(executionCount, 2);
    assert.ok(peakPages >= 2, 'at least two different URL pairs are in flight together');
    assert.equal(result.candidates.length, 1); assert.ok(result.uncertainties.some(item => item.includes('unknown supplier ID')));
    assert.equal(jobs.filter(job => job.status === 'completed').length, 2);
    assert.equal(usage.filter(item => item.kind === 'searches').length, 2);
    assert.equal(usage.filter(item => item.kind === 'fetches').length, 8, 'fragment duplicate is fetched only once per track');
    assert.equal(usage.reduce((sum, item) => sum + item.credits, 0), 18);
    for (const request of requests) {
      assert.equal(new Headers(request.init?.headers).get('X-Keenable-Title'), 'autonomous-sourcing');
      if (request.url.pathname.endsWith('/search')) {
        const body = JSON.parse(request.init?.body as string); assert.equal(body.max_results, 5); assert.deepEqual(body.exclude_domains, EXCLUDED_DOMAINS);
        if (body.query.includes('Official Chinese')) for (const term of ['DIN912', 'cold heading', 'heat treatment', 'export']) assert.ok(body.query.includes(term));
        else for (const term of ['12.9级', '内六角圆柱头螺钉', 'ISO4762', '生产厂家', '紧固件', '海盐', '宁波', '永年', '嘉善']) assert.ok(body.query.includes(term));
      } else {
        assert.equal(request.init?.method, 'GET'); assert.equal(request.url.searchParams.get('live'), 'true');
        if (!request.url.searchParams.has('prompt')) assert.equal(request.url.searchParams.get('max_chars'), '25000');
      }
    }
    assert.ok(![...store.values.values()].join('\n').includes('test-only-key'));
    const report = await store.get<Record<string, any>>('cases/case-test/research/attempt-one/run_report.json');
    assert.equal(report?.mode, 'live'); assert.equal(report?.status, 'completed');
    assert.equal(report?.searches, 2); assert.equal(report?.fetches, 8); assert.equal(report?.credits, 18);
    assert.equal(report?.codexJobs, 3); assert.equal(report?.archilExecs, 2); assert.ok(report?.durationMs >= 0);
  } finally { if (previous === undefined) delete process.env.KEENABLE_API_KEY; else process.env.KEENABLE_API_KEY = previous; }
});

test('saved research copies historical raw evidence before real synthesis and scoped verification without any web request', async () => {
  const previous = process.env.KEENABLE_API_KEY; delete process.env.KEENABLE_API_KEY;
  const store = new MemoryStore();
  const historical: EvidencePage = { requestedUrl: 'http://acme-fasteners.com/product', url: finalUrl, title: 'Acme', markdown: raw,
    extraction: 'Navigation aid only.', fetchedAt: '2026-11-01T12:00:00Z', truncated: true, extractionUrl: finalUrl };
  const sourceRoot = 'cases/previous-case/research/previous-attempt';
  const replayState: CaseState = { ...state, id: 'replay-case', researchAttempt: 'new-attempt', researchMode: 'saved research',
    researchReplay: { caseId: 'previous-case', attemptId: 'previous-attempt' } };
  const replayRoot = 'cases/replay-case/research/new-attempt';
  for (const track of ['english', 'chinese']) await store.immutable(`${sourceRoot}/${track}/input/raw_evidence.json`, [historical]);
  const sourceBefore = [...store.values.entries()];
  let modelCalls = 0, execCalls = 0, webCalls = 0, usageCalls = 0;
  const model = { async run<T>(job: ModelJob): Promise<T> {
    modelCalls++;
    if (job.kind.endsWith('sourcing')) {
      for (const track of ['english', 'chinese']) assert.deepEqual(await store.get(`${replayRoot}/${track}/input/raw_evidence.json`), [historical]);
      assert.deepEqual((job.input as { pages: EvidencePage[] }).pages, [historical]);
      return { candidates: [draft], uncertainties: [] } as T;
    }
    const candidates = (job.input as { candidates: { supplierId: string }[] }).candidates;
    return { selectedSupplierIds: [candidates[0]!.supplierId], uncertainties: [] } as T;
  } };
  try {
    const service = new ResearchService({ store, model, events, diskId: 'dsk-test', verifierBundle: '// fixture verifier',
      transport: (async () => { webCalls++; throw new Error('Replay must not contact Keenable.'); }) as typeof fetch,
      onUsage: () => { usageCalls++; }, onExec: () => {},
      execute: async options => {
        execCalls++;
        const mounts = options.disks as Record<string, { subdirectory: string; readOnly?: boolean; conditional?: boolean }>;
        assert.equal(mounts.input?.readOnly, true); assert.equal(mounts.output?.conditional, true);
        const input = mounts.input!.subdirectory.replace('autonomous-sourcing/v1/', '');
        const output = mounts.output!.subdirectory.replace('autonomous-sourcing/v1/', '');
        const pages = await store.get<EvidencePage[]>(`${input}/raw_evidence.json`);
        const candidates = await store.get<CandidateDraft[]>(`${input}/candidate_drafts.json`);
        await store.put(`${output}/verified.json`, verifyCandidates(candidates!, pages!, DEMO_RFQ));
        return { exitCode: 0, stdout: '', stderr: '' };
      } });
    const result = await service.run(replayState);
    assert.equal(modelCalls, 3); assert.equal(execCalls, 2); assert.equal(webCalls, 0); assert.equal(usageCalls, 0);
    assert.equal(result.candidates[0]?.fingerprints[0]?.fetchedAt, historical.fetchedAt);
    assert.equal(result.candidates[0]?.fingerprints[0]?.truncated, true);
    assert.ok(result.uncertainties.some(text => text.includes('historical') && text.includes('not refreshed')));
    for (const [key, value] of sourceBefore) assert.equal(store.values.get(key), value, 'source evidence remains unchanged');
    const provenance = await store.get<Record<string, any>>(`${replayRoot}/english/replay.json`);
    assert.equal(provenance?.sourceCaseId, 'previous-case'); assert.equal(provenance?.sourceAttemptId, 'previous-attempt');
    const report = await store.get<Record<string, any>>(`${replayRoot}/run_report.json`);
    assert.equal(report?.mode, 'saved research'); assert.equal(report?.status, 'completed');
    assert.equal(report?.searches, 0); assert.equal(report?.fetches, 0); assert.equal(report?.credits, 0);
    assert.equal(report?.codexJobs, 3); assert.equal(report?.archilExecs, 2); assert.deepEqual(report?.replaySource, replayState.researchReplay);
  } finally { if (previous === undefined) delete process.env.KEENABLE_API_KEY; else process.env.KEENABLE_API_KEY = previous; }
});

test('imported RFQ conditions reach both synthesis tracks and the evaluator with explicit eligibility uncertainty guidance', async () => {
  const store = new MemoryStore();
  const conditions = ['TEST ONLY: goods must have the specified domestic origin.', 'TEST ONLY: supplier eligibility requires buyer approval.', 'TEST ONLY: substitutions require written authorization.'];
  const importedState: CaseState = { ...state, id: 'source-conditions-case', researchMode: 'saved research',
    researchReplay: { caseId: 'prior-case', attemptId: 'prior-attempt' },
    rfqSource: { id: 'uploaded-rfq-line-1', kind: 'document', diskId: null, diskName: null, path: 'rfq-uploads/test/source.json',
      sha256: 'a'.repeat(64), revision: 'TEST ONLY revision', title: 'TEST ONLY complete RFQ', importedAt: '2026-11-11T00:00:00Z', warnings: conditions } };
  const before = structuredClone(importedState);
  const page: EvidencePage = { requestedUrl: finalUrl, url: finalUrl, title: 'TEST ONLY supplier evidence', markdown: raw,
    extraction: '', fetchedAt: '2026-11-01T12:00:00Z', truncated: false, extractionUrl: finalUrl };
  for (const track of ['english', 'chinese']) await store.put(`cases/prior-case/research/prior-attempt/${track}/input/raw_evidence.json`, [page]);
  const jobs: ModelJob[] = [];
  const uncertainty = 'TEST ONLY: technical relevance does not resolve the source eligibility and origin conditions.';
  const service = new ResearchService({ store, events, diskId: 'dsk-test', verifierBundle: '// TEST ONLY verifier', onExec: () => {}, onUsage: () => {},
    transport: (async () => { throw new Error('Saved evidence test must not access the network'); }) as typeof fetch,
    model: { async run<T>(job: ModelJob): Promise<T> {
      jobs.push(job);
      assert.deepEqual((job.input as { sourceRequirementsAndWarnings: string[] }).sourceRequirementsAndWarnings, conditions);
      for (const term of ['untrusted RFQ context', 'eligibility', 'country-of-origin', 'substitution', 'apparent incompatibilities', 'Technical fit alone']) assert.ok(job.instructions.includes(term), `${job.kind} retains ${term}`);
      if (job.kind.endsWith('sourcing')) return { candidates: [structuredClone(draft)], uncertainties: [uncertainty] } as T;
      const candidates = (job.input as { candidates: { supplierId: string }[] }).candidates;
      return { selectedSupplierIds: [candidates[0]!.supplierId], uncertainties: [uncertainty] } as T;
    } },
    execute: async options => {
      const mounts = options.disks as Record<string, { subdirectory: string }>;
      const input = mounts.input!.subdirectory.replace('autonomous-sourcing/v1/', '');
      const output = mounts.output!.subdirectory.replace('autonomous-sourcing/v1/', '');
      const candidates = await store.get<CandidateDraft[]>(`${input}/candidate_drafts.json`);
      const pages = await store.get<EvidencePage[]>(`${input}/raw_evidence.json`);
      await store.put(`${output}/verified.json`, verifyCandidates(candidates!, pages!, DEMO_RFQ));
      return { exitCode: 0, stdout: '', stderr: '' };
    } });
  const result = await service.run(importedState);
  assert.deepEqual(jobs.map(job => job.kind).sort(), ['chinese sourcing', 'english sourcing', 'supplier evaluation']);
  assert.equal(result.candidates.length, 1); assert.ok(result.uncertainties.includes(uncertainty));
  assert.deepEqual(importedState, before);
});

test('saved research rejects absent, incomplete or invalid source evidence without synthetic or live fallback', async () => {
  const previous = process.env.KEENABLE_API_KEY; delete process.env.KEENABLE_API_KEY;
  try {
    for (const scenario of ['no-reference', 'missing-track', 'invalid-page', 'empty-source'] as const) {
      const store = new MemoryStore(); let jobs = 0;
      const service = new ResearchService({ store, events, diskId: 'dsk-test', verifierBundle: '// fixture', onExec: () => {}, onUsage: () => {},
        model: { async run<T>(): Promise<T> { jobs++; throw new Error('Should not synthesize invalid evidence'); } },
        execute: async () => { jobs++; throw new Error('Should not execute invalid evidence'); },
        transport: (async () => { jobs++; throw new Error('Should not fetch fallback evidence'); }) as typeof fetch });
      const source = { caseId: 'source-case', attemptId: 'source-attempt' };
      if (scenario !== 'no-reference') {
        await store.immutable('cases/source-case/research/source-attempt/english/input/raw_evidence.json', scenario === 'invalid-page' ? [{ markdown: raw }] : []);
        if (scenario !== 'missing-track') await store.immutable('cases/source-case/research/source-attempt/chinese/input/raw_evidence.json', []);
      }
      await assert.rejects(service.run({ ...state, researchMode: 'saved research', researchReplay: scenario === 'no-reference' ? undefined : source }), /Saved research|Saved english|Saved chinese/);
      assert.equal(jobs, 0);
      const report = await store.get<Record<string, unknown>>('cases/case-test/research/attempt-one/run_report.json');
      assert.equal(report?.status, 'error'); assert.equal(report?.codexJobs, 0);
    }
  } finally { if (previous === undefined) delete process.env.KEENABLE_API_KEY; else process.env.KEENABLE_API_KEY = previous; }
});
