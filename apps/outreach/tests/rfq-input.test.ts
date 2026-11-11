import test from 'node:test';
import assert from 'node:assert/strict';
import { isOutreachReady, missingOutreachFields, parseRfq, requireOutreachReady, requireResearchConnection } from '../server/rfq-input.js';
import { DEMO_RFQ } from '../server/fixtures.js';

test('manual RFQ preserves supplied specifications and strips unrelated properties', () => {
  const input = { ...DEMO_RFQ, description: '  Steel beams for a house  ', standard: 'ASTM A992', size: 'W8x18, 20 ft', grade: '50', finish: 'uncoated', quantity: 2, currency: 'USD', targetUnitPrice: 350, maxUnitPrice: 500, unrelated: 'not persisted' };
  const parsed = parseRfq(input)!;
  assert.equal(parsed.description, 'Steel beams for a house');
  assert.equal(parsed.standard, 'ASTM A992');
  assert.equal(parsed.quantity, 2);
  assert.equal(parsed.requiredBy, null);
  assert.equal('unrelated' in parsed, false);
  assert.equal(parseRfq(undefined), undefined);
});

test('RFQ rejects malformed fields, impossible dates and invalid commercial bounds', () => {
  for (const input of [null, [], { ...DEMO_RFQ, grade: ' ' }, { ...DEMO_RFQ, quantity: 1.5 }, { ...DEMO_RFQ, targetUnitPrice: 1 }, { ...DEMO_RFQ, maxUnitPrice: Infinity }, { ...DEMO_RFQ, requiredBy: '2026-02-31' }, { ...DEMO_RFQ, requiredBy: undefined }]) {
    assert.throws(() => parseRfq(input), (error: any) => error.status === 400);
  }
  assert.equal(parseRfq({ ...DEMO_RFQ, requiredBy: '2028-02-29' })?.requiredBy, '2028-02-29');
});

test('real research cannot be acknowledged as started without its connection, but replay and inbox resume can run', () => {
  assert.throws(() => requireResearchConnection({ researchMode: 'live', researchComplete: false }, ' '), (error: any) => error.status === 428 && /RFQ saved/.test(error.message));
  assert.doesNotThrow(() => requireResearchConnection({ researchMode: 'live', researchComplete: false }, 'test-only'));
  assert.doesNotThrow(() => requireResearchConnection({ researchMode: 'saved research', researchComplete: false }, undefined));
  assert.doesNotThrow(() => requireResearchConnection({ researchMode: 'live', researchComplete: true }, undefined));
});

test('explicit unknown requirements are preserved for sourcing and block outreach with exact missing fields', () => {
  const input = { description: 'Manufacturer part ABC-123', standard: null, size: null, grade: null, finish: null, quantity: null, currency: null, incoterm: null, destination: null, targetUnitPrice: null, maxUnitPrice: null, requiredBy: null };
  const rfq = parseRfq(input)!;
  assert.deepEqual(rfq, input); assert.equal(isOutreachReady(rfq), false);
  assert.deepEqual(missingOutreachFields(rfq), ['standard', 'size', 'grade', 'finish', 'quantity', 'currency', 'incoterm', 'destination', 'targetUnitPrice', 'maxUnitPrice']);
  assert.throws(() => requireOutreachReady(rfq), (error: any) => error.status === 428 && error.missingFields.includes('targetUnitPrice') && error.message.includes('standard'));
  assert.equal(isOutreachReady(DEMO_RFQ), true); assert.doesNotThrow(() => requireOutreachReady(DEMO_RFQ));
  assert.equal(parseRfq({ ...DEMO_RFQ, targetUnitPrice: null })?.targetUnitPrice, null);
  assert.equal(parseRfq({ ...DEMO_RFQ, maxUnitPrice: null })?.maxUnitPrice, null);
});

test('null is explicit unknown data, but omitted or undefined RFQ keys and blank strings are rejected', () => {
  for (const key of Object.keys(DEMO_RFQ)) {
    const omitted = { ...DEMO_RFQ } as Record<string, unknown>; delete omitted[key];
    assert.throws(() => parseRfq(omitted), (error: any) => error.status === 400, key);
    assert.throws(() => parseRfq({ ...DEMO_RFQ, [key]: undefined }), (error: any) => error.status === 400, key);
  }
  for (const description of [null, '', '  ']) assert.throws(() => parseRfq({ ...DEMO_RFQ, description }), /description/);
  for (const key of ['standard', 'size', 'grade', 'finish', 'currency', 'incoterm', 'destination']) assert.throws(() => parseRfq({ ...DEMO_RFQ, [key]: ' ' }), /RFQ requires/);
});
