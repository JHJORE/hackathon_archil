import type { Rfq } from '../shared/types.js';
import { DEMO_RFQ } from './fixtures.js';
import { parseRfq } from './rfq-input.js';
/** Empty Run uses the backend example; partial requests never inherit its buying terms. */
export function runRfq(input: unknown): Rfq {
  if (input == null) return structuredClone(DEMO_RFQ);
  if (typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('RFQ must be an object'),{status:400});
  const source = input as Record<string,unknown>;
  const fields = Object.keys(DEMO_RFQ);
  if (!fields.some(key => source[key] != null && String(source[key]).trim() !== '')) return structuredClone(DEMO_RFQ);
  const result = Object.fromEntries(fields.map(key => [key,source[key] == null || source[key] === '' ? null : source[key]]));
  result.description ||= ['standard','size','grade','finish'].map(key=>result[key]).filter(Boolean).join(' ') || 'Sourcing request';
  return parseRfq(result)!;
}
