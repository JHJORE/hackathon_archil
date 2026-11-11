import type { CaseState, OutreachRfq, Rfq } from '../shared/types.js';

const badInput = (message: string) => Object.assign(new Error(message), { status: 400 });

/** The API accepts only the RFQ contract, without silently inventing missing requirements. */
export function parseRfq(input: unknown): Rfq | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badInput('RFQ must be a JSON object');
  const source = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of ['description', 'standard', 'size', 'grade', 'finish', 'currency', 'incoterm', 'destination']) {
    if (field !== 'description' && source[field] === null) { result[field] = null; continue; }
    if (typeof source[field] !== 'string' || !source[field].trim() || source[field].length > 2000) throw badInput(`RFQ requires ${field}`);
    result[field] = source[field].trim();
  }
  for (const field of ['quantity', 'targetUnitPrice', 'maxUnitPrice']) {
    if (source[field] === null) { result[field] = null; continue; }
    if (typeof source[field] !== 'number' || !Number.isFinite(source[field]) || source[field] <= 0) throw badInput(`RFQ requires positive ${field}`);
    result[field] = source[field];
  }
  if (result.quantity !== null && !Number.isSafeInteger(result.quantity)) throw badInput('Quantity must be a positive whole number');
  if (result.targetUnitPrice !== null && result.maxUnitPrice !== null && Number(result.targetUnitPrice) > Number(result.maxUnitPrice)) throw badInput('Target price cannot exceed maximum price');
  const requiredBy = source.requiredBy;
  if (requiredBy !== null) {
    if (typeof requiredBy !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(requiredBy)) throw badInput('requiredBy must be an ISO date or null');
    const date = new Date(`${requiredBy}T00:00:00Z`);
    if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== requiredBy) throw badInput('Required delivery date is not a valid calendar date');
  }
  result.requiredBy = requiredBy;
  return result as Rfq;
}

const outreachFields = ['standard', 'size', 'grade', 'finish', 'quantity', 'currency', 'incoterm', 'destination', 'targetUnitPrice', 'maxUnitPrice'] as const;
export function missingOutreachFields(rfq: Rfq): Array<typeof outreachFields[number]> {
  return outreachFields.filter(field => rfq[field] == null || (typeof rfq[field] === 'string' && !(rfq[field] as string).trim()));
}
export function isOutreachReady(rfq: Rfq): rfq is OutreachRfq {
  return missingOutreachFields(rfq).length === 0;
}
export function requireOutreachReady(rfq: Rfq): asserts rfq is OutreachRfq {
  const missingFields = missingOutreachFields(rfq);
  if (missingFields.length) throw Object.assign(new Error(`Review these missing RFQ fields before email outreach or negotiation: ${missingFields.join(', ')}.`), { status: 428, missingFields });
}

export function rfqUncertainties(rfq: Rfq): string[] {
  const missingFields = missingOutreachFields(rfq);
  return [
    ...(missingFields.length ? [`Research can use the known requirements; review before outreach: ${missingFields.join(', ')}.`] : []),
    ...(rfq.requiredBy === null ? ['Required delivery date is not specified; confirm it before purchasing.'] : []),
  ];
}

export function requireResearchConnection(state: Pick<CaseState, 'researchMode' | 'researchComplete'>, key: string | undefined): void {
  if (!state.researchComplete && state.researchMode === 'live' && !key?.trim()) {
    throw Object.assign(new Error('RFQ saved. Connect Keenable before starting live supplier research: run npm run connect:keenable in the app folder, approve the link, then click Start sourcing. N1WEB is the separate credit code.'), { status: 428 });
  }
}
