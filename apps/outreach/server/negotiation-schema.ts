import type { NegotiationResult, Quote, Rfq, SupplierState } from '../shared/types.js';
import { isOutreachReady, missingOutreachFields } from './rfq-input.js';

const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
export const negotiationSchema: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  properties: {
    quote: {
      type: 'object', additionalProperties: false,
      properties: {
        unitPrice: nullableNumber, currency: nullableString, quantity: nullableNumber,
        standard: nullableString, size: nullableString, grade: nullableString, finish: nullableString,
        incoterm: nullableString, destination: nullableString, leadTimeDays: nullableNumber,
        notes: { type: 'array', items: { type: 'string' } },
      },
      required: ['unitPrice', 'currency', 'quantity', 'standard', 'size', 'grade', 'finish', 'incoterm', 'destination', 'leadTimeDays', 'notes'],
    },
    counterofferText: nullableString, explanation: { type: 'string' },
  }, required: ['quote', 'counterofferText', 'explanation'],
};

export function validateResult(value: unknown): NegotiationResult {
  const v = value as NegotiationResult;
  if (!v || typeof v !== 'object' || !v.quote || typeof v.explanation !== 'string' || !(v.counterofferText === null || typeof v.counterofferText === 'string')) throw new Error('Model returned an invalid negotiation result');
  const q = v.quote;
  for (const key of ['currency', 'standard', 'size', 'grade', 'finish', 'incoterm', 'destination'] as const) {
    if (!(q[key] === null || typeof q[key] === 'string')) throw new Error(`Invalid quote field: ${key}`);
  }
  for (const key of ['unitPrice', 'quantity', 'leadTimeDays'] as const) {
    if (!(q[key] === null || (typeof q[key] === 'number' && Number.isFinite(q[key])))) throw new Error(`Invalid quote field: ${key}`);
  }
  if (!Array.isArray(q.notes) || q.notes.some(n => typeof n !== 'string')) throw new Error('Invalid quote notes');
  return structuredClone(v);
}

function normalized(key: string, value: string): string {
  const s = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (key === 'standard' || key === 'size') return s.replace(/\s/g, '').replace(/×/g, 'x');
  if (key === 'finish') return s.replace(/[\s-]/g, '');
  return s;
}

export function evaluateQuote(rfq: Rfq, quote: Quote, previous: SupplierState): {
  status: SupplierState['status']; explanation: string; nextAction: string; counter: boolean;
} {
  if (!isOutreachReady(rfq)) return { status: 'needs attention', explanation: `Unresolved RFQ fields: ${missingOutreachFields(rfq).join(', ')}.`, nextAction: 'Review the missing buyer requirements before negotiating or judging a price target.', counter: false };
  const missing = Object.entries(quote).filter(([key, value]) => key !== 'notes' && (value === null || value === '')).map(([key]) => key);
  if (missing.length) return { status: 'needs attention', explanation: `Unresolved quote fields: ${missing.join(', ')}.`, nextAction: 'Clarify the missing terms; no counteroffer sent.', counter: false };
  const mismatches: string[] = [];
  for (const key of ['currency', 'standard', 'size', 'grade', 'finish', 'incoterm', 'destination'] as const) {
    if (normalized(key, quote[key]!) !== normalized(key, rfq[key])) mismatches.push(key);
  }
  if (quote.quantity !== rfq.quantity) mismatches.push('quantity');
  if (quote.unitPrice! <= 0 || !Number.isInteger(quote.quantity) || quote.leadTimeDays! < 0 || !Number.isInteger(quote.leadTimeDays)) mismatches.push('invalid numeric terms');
  if (mismatches.length) return { status: 'needs attention', explanation: `Quote differs from the RFQ: ${mismatches.join(', ')}.`, nextAction: 'Resolve the specification or commercial mismatch.', counter: false };
  if (rfq.requiredBy) {
    const due = Date.parse(rfq.requiredBy);
    const arrives = Date.now() + quote.leadTimeDays! * 86400000;
    if (!Number.isFinite(due) || arrives > due + 86399999) return { status: 'needs attention', explanation: 'Quoted lead time does not establish delivery by the required date.', nextAction: 'Confirm an achievable delivery date.', counter: false };
  }
  if (quote.unitPrice! <= rfq.targetUnitPrice) return { status: 'target met', explanation: 'All stated terms match and the unit price meets the target. This is not an accepted purchase.', nextAction: rfq.requiredBy ? 'Buyer review before any purchase commitment.' : 'Confirm the missing delivery deadline, then buyer review.', counter: false };
  if (previous.round === 0) return { status: 'negotiating', explanation: 'Terms match; request the target unit price without changing specifications or quantity.', nextAction: 'Await the supplier response to the single permitted counteroffer.', counter: true };
  if (quote.unitPrice! <= rfq.maxUnitPrice) return { status: 'closed', explanation: 'The final offer is above target but within the maximum price. The one-counteroffer limit is reached.', nextAction: 'Buyer decision required; no order placed.', counter: false };
  return { status: 'needs attention', explanation: 'The final offer exceeds the maximum price and the one-counteroffer limit is reached.', nextAction: 'Buyer decision required; no further counteroffer.', counter: false };
}
