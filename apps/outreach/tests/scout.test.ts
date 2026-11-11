import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ScoutService } from '../server/scout.js';
import { rfqDocument } from '../server/rfq-document.js';

const now = () => new Date('2026-11-11T05:00:00Z');
const published = (id = 'rfq-test-one') => ({ id, status: 'open', is_open: true, found_in_run: '2026-11-11T04-13-40-396Z',
  title: 'Motor control centers', solicitation_number: 'SPEC-123', buyer: { agency: 'Public Utility' },
  source_url: 'https://example.org/solicitation', summary: 'Seven indoor control centers.',
  line_items: [{ product: 'Indoor 480V motor control center', quantity: 7, unit: 'each', spec: 'Technical specification Rev. B' }],
  required_standards: ['Technical Specification Rev. B'], delivery: { location: 'Georgia, USA', terms: null },
  dates: { response_due: '2026-11-12', response_due_time: '5 PM EST' },
  contact: { email: 'buyer@example.org' }, submission: { email: 'bids@example.org' },
});
function fixture(records = [published()]) {
  const values = new Map<string, string>([['rfqs/latest.json', JSON.stringify(records)]]);
  for (const record of records) values.set(`rfqs/open/${record.id}.json`, JSON.stringify(record, null, 2));
  const reads: string[] = [];
  const service = new ScoutService({ diskId: 'dsk-test-scout', store: { async getText(key) { reads.push(key); return values.get(key) ?? null; } }, now });
  return { service, values, reads };
}

test('scout imports only published single-product fields and preserves exact raw provenance', async () => {
  const { service, values } = fixture();
  const overview = await service.overview();
  assert.equal(overview.disk.connected, true); assert.equal(overview.disk.access, 'read-only');
  assert.equal(overview.items.length, 1); assert.equal(overview.error, null);
  const item = overview.items[0]!;
  assert.equal(item.rfq.quantity, 7); assert.equal(item.rfq.standard, 'Technical Specification Rev. B');
  assert.equal(item.rfq.destination, 'Georgia, USA');
  assert.equal(item.dueDate, '2026-11-12'); assert.equal(item.rfq.requiredBy, undefined);
  for (const key of ['size', 'grade', 'finish', 'targetUnitPrice', 'maxUnitPrice', 'currency', 'incoterm'] as const) assert.equal(item.rfq[key], undefined);
  assert.equal(item.source.path, 'rfqs/open/rfq-test-one.json');
  assert.equal(item.source.revision, '2026-11-11T04-13-40-396Z');
  assert.equal(item.source.sha256, createHash('sha256').update(values.get(item.source.path)!).digest('hex'));
  assert.ok(item.warnings.some(value => value.includes('not manufacturer outreach recipients')));
  assert.ok(!JSON.stringify(item.rfq).includes('buyer@example.org'));
  const resolved = await service.resolve(item.id);
  assert.equal(resolved.raw, values.get(item.source.path)); assert.deepEqual(resolved.item, item);
});

test('scout does not combine product quantities or treat bulk units as each', async () => {
  const multi = published(); multi.line_items.push({ product: 'Other product', quantity: 4, unit: 'each', spec: 'Separate spec' });
  const multiItem = (await fixture([multi]).service.overview()).items[0]!;
  assert.equal(multiItem.rfq.quantity, undefined); assert.equal(multiItem.rfq.standard, undefined);
  assert.ok(multiItem.warnings.some(value => value.includes('quantities are not combined')));
  for (const unit of ['kg', 'tons', '', 'boxes']) {
    const record = published(); record.line_items[0]!.unit = unit;
    assert.equal((await fixture([record]).service.overview()).items[0]!.rfq.quantity, undefined);
  }
});

test('scout bounds exact source reads at50 and rejects paths or IDs outside its fresh index', async () => {
  const { service, reads } = fixture(Array.from({ length: 55 }, (_, index) => published(`rfq-test-${index}`)));
  const overview = await service.overview();
  assert.equal(overview.items.length, 50); assert.equal(overview.limited, true);
  assert.equal(reads.filter(path => path.startsWith('rfqs/open/')).length, 50);
  await assert.rejects(service.resolve('../scout/secret'), /Invalid scout source ID/);
  await assert.rejects(service.resolve('rfq-test-54'), /not in the current scout review list/);
  assert.ok(!reads.some(path => path.includes('secret') || path.endsWith('rfq-test-54.json')));
});

test('resolve re-reads current source bytes instead of accepting a stale displayed hash', async () => {
  const { service, values } = fixture();
  const before = (await service.overview()).items[0]!;
  const fresh = published(); fresh.line_items[0]!.quantity = 9;
  values.set(before.source.path, JSON.stringify(fresh));
  const resolved = await service.resolve(before.id);
  assert.notEqual(resolved.item.source.sha256, before.source.sha256);
  assert.equal(resolved.item.rfq.quantity, 9);
  values.set('rfqs/latest.json', '[]');
  await assert.rejects(service.resolve(before.id), /not in the current scout review list/);
});

test('scout rejects identity mismatch, unsafe URLs and malformed dates without exposing transport errors', async () => {
  const { service, values } = fixture();
  const bad = published(); bad.id = 'rfq-other';
  values.set('rfqs/open/rfq-test-one.json', JSON.stringify(bad));
  const invalid = await service.overview();
  assert.equal(invalid.items.length, 0); assert.match(invalid.error!, /could not be read or validated/);
  await assert.rejects(service.resolve('rfq-test-one'), /published identity/);
  const unsafe = published(); unsafe.source_url = 'javascript:alert(1)'; unsafe.dates.response_due = '2026-02-30';
  const unsafeItem = (await fixture([unsafe]).service.overview()).items[0]!;
  assert.equal(unsafeItem.sourceUrl, null); assert.equal(unsafeItem.dueDate, null);
  const unavailable = new ScoutService({ diskId: 'dsk-test-scout', store: { getText: async () => { throw new Error('secret-key-do-not-leak'); } }, now });
  assert.ok(!JSON.stringify(await unavailable.overview()).includes('secret-key'));
  await assert.rejects(unavailable.resolve('rfq-test-one'), error => error instanceof Error && !error.message.includes('secret-key'));
});

test('unconfigured Scout never reads a provider and leaves the fictional sample available', async () => {
  for (const env of [{}, { SCOUT_DISK_ID: '   ' }]) {
    let reads = 0;
    const service = new ScoutService({ env: () => env, now, store: { getText: async () => { reads++; throw new Error('Provider must not be read'); } } });
    const overview = await service.overview();
    assert.equal(overview.disk.connected, false); assert.equal(overview.disk.id, '');
    assert.deepEqual(overview.items, []); assert.equal(overview.limited, false);
    assert.match(overview.error!, /Configure SCOUT_DISK_ID/);
    await assert.rejects(service.resolve('rfq-test-one'), (error: Error & { status?: number }) => error.status === 428 && error.message.includes('SCOUT_DISK_ID'));
    assert.equal(reads, 0);
  }
  const document = await rfqDocument();
  assert.equal(document.item.source.kind, 'document');
  assert.equal(document.item.rfq.quantity, 50000);
  assert.equal(JSON.parse(document.raw).fictional, true);
  assert.match(document.item.title, /Fictional/);
});
