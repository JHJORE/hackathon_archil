import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRfq, requireResearchConnection } from '../server/rfq-input.js';
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
