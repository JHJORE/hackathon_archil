import type { CaseState, Rfq } from '../shared/types.js';

const badInput = (message: string) => Object.assign(new Error(message), { status: 400 });

/** The API accepts only the RFQ contract, without silently inventing missing requirements. */
export function parseRfq(input: unknown): Rfq | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badInput('RFQ must be a JSON object');
  const source = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of ['description', 'standard', 'size', 'grade', 'finish', 'currency', 'incoterm', 'destination']) {
    if (typeof source[field] !== 'string' || !source[field].trim() || source[field].length > 2000) throw badInput(`RFQ requires ${field}`);
    result[field] = source[field].trim();
  }
  for (const field of ['quantity', 'targetUnitPrice', 'maxUnitPrice']) {
    if (typeof source[field] !== 'number' || !Number.isFinite(source[field]) || source[field] <= 0) throw badInput(`RFQ requires positive ${field}`);
    result[field] = source[field];
  }
  if (!Number.isSafeInteger(result.quantity)) throw badInput('Quantity must be a positive whole number');
  if (Number(result.targetUnitPrice) > Number(result.maxUnitPrice)) throw badInput('Target price cannot exceed maximum price');
  const requiredBy = source.requiredBy;
  if (requiredBy !== null) {
    if (typeof requiredBy !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(requiredBy)) throw badInput('requiredBy must be an ISO date or null');
    const date = new Date(`${requiredBy}T00:00:00Z`);
    if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== requiredBy) throw badInput('Required delivery date is not a valid calendar date');
  }
  result.requiredBy = requiredBy;
  return result as Rfq;
}

export function requireResearchConnection(state: Pick<CaseState, 'researchMode' | 'researchComplete'>, key: string | undefined): void {
  if (!state.researchComplete && state.researchMode === 'live' && !key?.trim()) {
    throw Object.assign(new Error('RFQ saved. Connect Keenable before starting live supplier research: run npm run connect:keenable in the app folder, approve the link, then click Start sourcing. N1WEB is the separate credit code.'), { status: 428 });
  }
}
