import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateCandidates, fingerprint, manufacturerDomain, normalizePhone, sameSupplier, verifyCandidates } from '../server/grounding.js';
import { DEMO_RFQ } from '../server/fixtures.js';
import type { Candidate, CandidateDraft, EvidencePage } from '../shared/types.js';

const raw = 'Acme Fasteners Co. Ltd. 宁波艾克紧固件有限公司\nWe manufacture socket head cap screws. ISO 4762 M8x30 grade 12.9 black oxide. ISO 9001.\nContact sales@acme-fasteners.com or +86 138 0013 8000. 宁波市\n统一社会信用代码 91330200610234567A 浙ICP备12345678号';
const page: EvidencePage = { requestedUrl: 'http://acme-fasteners.com/product', url: 'https://www.acme-fasteners.com/product', title: 'Acme', markdown: raw,
  extraction: 'Email ceo@imagined.com, phone +1 415 555 2671. Certified ISO 14001.', fetchedAt: '2026-11-10T12:00:00Z', truncated: false, extractionUrl: 'https://www.acme-fasteners.com/product' };
const draft: CandidateDraft = {
  companyName: 'Acme Fasteners Co. Ltd.', chineseName: '宁波艾克紧固件有限公司', city: '宁波市', sourceUrl: page.requestedUrl,
  publishedContacts: { emails: ['sales@acme-fasteners.com', 'ceo@imagined.com'], phones: ['13800138000', '+1 415 555 2671'] },
  technicalFit: { score: 100, summary: 'All certifications proven', standards: ['ISO 4762', 'ISO 14001'], grades: ['12.9'], finish: 'black oxide' },
  manufacturingEvidence: ['We manufacture socket head cap screws.', 'Operates 19 factories'], certifications: ['ISO 9001', 'ISO 14001'],
  identifiers: { uscc: '91330200610234567A', icp: '浙ICP备12345678号' },
  evidenceQuotes: [{ url: page.requestedUrl, text: 'We manufacture socket head cap screws.', claim: 'Certified ISO 14001 and owns 19 factories' },
    { url: page.url, text: 'Certified ISO 14001.', claim: 'ISO 14001' }], uncertainties: [],
};
function grounded(): Candidate { return verifyCandidates([structuredClone(draft)], [page], DEMO_RFQ).candidates[0]!; }

test('raw evidence grounds contacts and claims; extracted hallucinations are removed', () => {
  const candidate = grounded();
  assert.deepEqual(candidate.publishedContacts.emails, ['sales@acme-fasteners.com']);
  assert.deepEqual(candidate.publishedContacts.phones, ['+8613800138000']);
  assert.deepEqual(candidate.technicalFit.standards, ['ISO 4762']);
  assert.deepEqual(candidate.certifications, ['ISO 9001']);
  assert.deepEqual(candidate.manufacturingEvidence, ['We manufacture socket head cap screws.']);
  assert.equal(candidate.evidenceQuotes.length, 1);
  assert.equal(candidate.evidenceQuotes[0]?.claim, 'Published source excerpt; interpretation requires review.');
  assert.ok(!candidate.technicalFit.summary.includes('All certifications proven'));
  assert.equal(candidate.sourceUrl, page.url);
  assert.equal(candidate.fingerprints[0]?.url, page.url);
  assert.equal(candidate.fingerprints[0]?.sha256, fingerprint(raw));
});

test('raw SHA256, final URL metadata and truncation are preserved exactly', () => {
  assert.equal(fingerprint('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(fingerprint(raw), fingerprint(raw + '\n'));
  const candidate = verifyCandidates([draft], [{ ...page, truncated: true }], DEMO_RFQ).candidates[0]!;
  assert.equal(candidate.fingerprints[0]?.fetchedAt, page.fetchedAt);
  assert.equal(candidate.fingerprints[0]?.truncated, true);
  assert.ok(candidate.uncertainties.some(text => text.includes('truncated')));
});

test('unknown technical requirements remain unresolved after grounding a sourcing lead', () => {
  const rfq = { ...DEMO_RFQ, standard: null, size: null, grade: null, finish: null, quantity: null, currency: null, incoterm: null, destination: null, targetUnitPrice: null, maxUnitPrice: null };
  const candidate = verifyCandidates([draft], [page], rfq).candidates[0]!;
  assert.ok(candidate); assert.ok(candidate.technicalFit.score <= 50);
  assert.match(candidate.technicalFit.summary, /No reviewed technical specifications/);
  assert.ok(candidate.uncertainties.some(text => /requirements are unknown/.test(text)));
  assert.equal(rfq.standard, null); assert.equal(rfq.quantity, null);
});

test('unfetched sources, marketplace redirects and fabricated company names are rejected', () => {
  assert.equal(verifyCandidates([{ ...draft, sourceUrl: 'https://unknown.example.com' }], [page], DEMO_RFQ).candidates.length, 0);
  assert.equal(verifyCandidates([draft], [{ ...page, url: 'https://seller.alibaba.com/p' }], DEMO_RFQ).candidates.length, 0);
  assert.equal(verifyCandidates([{ ...draft, companyName: 'Made Up Works', chineseName: null }], [page], DEMO_RFQ).candidates.length, 0);
  assert.equal(manufacturerDomain('https://supplier.made-in-china.com/product'), null);
  assert.equal(manufacturerDomain('https://www.acme-fasteners.com/product'), 'acme-fasteners.com');
});

test('normalization handles Chinese phone formatting without accepting incomplete numbers', () => {
  assert.equal(normalizePhone('+86 138-0013-8000'), '+8613800138000');
  assert.equal(normalizePhone('13800138000'), '+8613800138000');
  assert.equal(normalizePhone('1234'), null);
});

test('grade substring and unsupported certification numbers are not factual matches', () => {
  const candidate = verifyCandidates([{ ...draft, technicalFit: { ...draft.technicalFit, grades: ['8.8'] }, certifications: ['ISO 9001'] }],
    [{ ...page, markdown: raw.replace('12.9', '18.8').replace('ISO 9001.', 'ISO 90010.') }], DEMO_RFQ).candidates[0]!;
  assert.deepEqual(candidate.technicalFit.grades, []);
  assert.deepEqual(candidate.certifications, []);
});

test('dedup requires independent identity signals and refuses contradictory legal identities', () => {
  const a = grounded();
  const b = structuredClone(a);
  assert.equal(sameSupplier(a, b), true);
  assert.equal(deduplicateCandidates([a, b]).candidates.length, 1);
  b.identity.uscc = '91330200610234567B';
  assert.equal(sameSupplier(a, b), false);
  assert.equal(deduplicateCandidates([a, b]).candidates.length, 2);
  b.identity.uscc = null; a.identity.uscc = null;
  b.identity.phones = []; b.identity.icp = null;
  assert.equal(sameSupplier(a, b), false, 'same name and domain alone do not merge');
  b.identity.phones = [...a.identity.phones];
  b.companyName = 'Another Subsidiary'; b.chineseName = '其他有限公司';
  assert.equal(sameSupplier(a, b), false, 'shared corporate domain and phone do not erase conflicting company identities');
});
