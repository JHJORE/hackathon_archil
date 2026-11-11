import type { Rfq, Quote } from '../shared/types.js';

export const DEMO_RFQ: Rfq = {
  description: 'Socket head cap screws for a manufacturing order',
  standard: 'ISO 4762', size: 'M8x30', grade: '12.9', finish: 'black oxide',
  quantity: 50000, currency: 'USD', incoterm: 'CIF', destination: 'Oakland',
  targetUnitPrice: 0.065, maxUnitPrice: 0.082, requiredBy: null,
};

export function quoteMessage(rfq: Rfq, unitPrice: number, overrides: Partial<Quote> = {}): string {
  const quote: Quote = {
    unitPrice, currency: rfq.currency, quantity: rfq.quantity,
    standard: rfq.standard, size: rfq.size, grade: rfq.grade, finish: rfq.finish,
    incoterm: rfq.incoterm, destination: rfq.destination, leadTimeDays: 21, notes: [], ...overrides,
  };
  return `SIMULATED SUPPLIER REPLY — test fixture, not a real commercial offer.\nWe quote ${quote.currency} ${quote.unitPrice} per piece for ${quote.quantity} pieces.\nStandard: ${quote.standard}; size: ${quote.size}; grade: ${quote.grade}; finish: ${quote.finish}.\nTerms: ${quote.incoterm} ${quote.destination}. Lead time: ${quote.leadTimeDays} days.\n${quote.notes.join(' ')}`;
}

export function initialRfqMessage(rfq: Rfq): string {
  return `SIMULATED RFQ — in-app test inbox only.\nPlease quote ${rfq.quantity.toLocaleString('en-US')} pieces of ${rfq.standard} ${rfq.size}, grade ${rfq.grade}, ${rfq.finish}.\nQuote in ${rfq.currency}, ${rfq.incoterm} ${rfq.destination}. Please confirm every specification, quantity, unit price and lead time in days.${rfq.requiredBy ? ` Required by: ${rfq.requiredBy}.` : ' Required delivery date is not yet specified.'}\nThis is a request for quotation, not a purchase commitment.`;
}

export function counterMessage(rfq: Rfq): string {
  return `SIMULATED COUNTEROFFER — in-app test inbox only.\nCan you offer ${rfq.currency} ${rfq.targetUnitPrice.toFixed(3)} per piece for ${rfq.quantity.toLocaleString('en-US')} pieces of ${rfq.standard} ${rfq.size}, grade ${rfq.grade}, ${rfq.finish}, on ${rfq.incoterm} ${rfq.destination} terms?\nPlease retain all requested specifications and quantity, and confirm lead time. This inquiry does not place an order or accept a quote.`;
}
