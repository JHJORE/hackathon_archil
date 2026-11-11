import type { Rfq, Quote, OutreachRfq } from '../shared/types.js';
import { requireOutreachReady } from './rfq-input.js';

export const DEMO_RFQ: OutreachRfq = {
  description: 'Socket head cap screws for a manufacturing order',
  standard: 'ISO 4762', size: 'M8x30', grade: '12.9', finish: 'black oxide',
  quantity: 50000, currency: 'USD', incoterm: 'CIF', destination: 'Oakland',
  targetUnitPrice: 0.065, maxUnitPrice: 0.082, requiredBy: null,
};

export function quoteMessage(rfq: Rfq, unitPrice: number, overrides: Partial<Quote> = {}): string {
  requireOutreachReady(rfq);
  const quote: Quote = {
    unitPrice, currency: rfq.currency, quantity: rfq.quantity,
    standard: rfq.standard, size: rfq.size, grade: rfq.grade, finish: rfq.finish,
    incoterm: rfq.incoterm, destination: rfq.destination, leadTimeDays: 21, notes: [], ...overrides,
  };
  const revised = unitPrice <= rfq.targetUnitPrice;
  return `Subject: ${revised ? 'Revised quotation' : 'Quotation'} — ${quote.standard} ${quote.size} — ${quote.quantity} pcs

Dear Procurement Team,

${revised ? 'Thank you for discussing the pricing with us. We have reviewed this order with our sales manager and can improve our offer as follows. All specifications and the order quantity remain unchanged.' : 'Thank you for your enquiry. We have reviewed the specification and quantity with our production team. Please find our quotation below.'}

Product: ${quote.standard} ${quote.size}
Grade: ${quote.grade}
Finish: ${quote.finish}
Quantity: ${quote.quantity} pieces
Unit price: ${quote.currency} ${quote.unitPrice} per piece
Delivery terms: ${quote.incoterm} ${quote.destination}
Lead time: ${quote.leadTimeDays} days

Please confirm the required arrival date and consignee details so we can coordinate the shipping schedule. We can provide the packing list and commercial invoice for your review before dispatch.

${revised ? 'Please let us know whether this revised price meets your requirements. We look forward to your feedback.' : 'Please review the offer and let us know if you have a target price for this quantity. We would be pleased to discuss it.'}
${quote.notes.length ? '\n'+quote.notes.join(' ')+'\n' : ''}
Best regards,
Export Sales Team`;

}

export function initialRfqMessage(rfq: Rfq): string {
  requireOutreachReady(rfq);
  return `Subject: Request for quotation — ${rfq.standard} ${rfq.size} — ${rfq.quantity.toLocaleString('en-US')} pcs

Dear Sales Team,

We are sourcing ${rfq.quantity.toLocaleString('en-US')} pieces of ${rfq.standard} ${rfq.size}, grade ${rfq.grade}, ${rfq.finish}, for an upcoming manufacturing order.

Please quote in ${rfq.currency} on ${rfq.incoterm} ${rfq.destination} terms. Please confirm the specification, unit price, minimum order quantity, packing arrangement and lead time in days. Please identify any deviation from our requirements separately.

${rfq.requiredBy ? `Our required delivery date is ${rfq.requiredBy}.` : 'Our required arrival date is being finalized; please indicate your available lead time.'}

We would appreciate your quotation and any relevant product documentation. This request does not place an order.

Best regards,
Procurement Team`;

}

export function counterMessage(rfq: Rfq): string {
  requireOutreachReady(rfq);
  return `Subject: Re: Quotation — ${rfq.standard} ${rfq.size}

Dear Sales Team,

Thank you for the detailed quotation. The specification is aligned with our requirement. We have reviewed the pricing against our budget for this order.

Could you improve the unit price to ${rfq.currency} ${rfq.targetUnitPrice.toFixed(3)} per piece for ${rfq.quantity.toLocaleString('en-US')} pieces of ${rfq.standard} ${rfq.size}, grade ${rfq.grade}, ${rfq.finish}, on ${rfq.incoterm} ${rfq.destination} terms?

Please retain the full quantity and all specifications, and confirm the lead time with your revised offer. We will review the final quotation before making a purchasing decision.

Thank you for working with us on this.

Best regards,
Procurement Team`;

}
