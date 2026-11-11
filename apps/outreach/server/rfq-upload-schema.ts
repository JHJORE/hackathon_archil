const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const nullableText = { type: ['string', 'null'], maxLength: 2000 };
const strings = { type: 'array', items: { type: 'string', maxLength: 2000 }, maxItems: 80 };
export const RFQ_FIELDS = ['description', 'standard', 'size', 'grade', 'finish', 'quantity', 'currency', 'incoterm', 'destination', 'targetUnitPrice', 'maxUnitPrice', 'requiredBy'] as const;
export const rfqUploadSchema = object({
  title: nullableText, reference: nullableText, buyer: nullableText, quoteDueDate: nullableText,
  lines: { type: 'array', minItems: 1, maxItems: 50, items: object({
    lineId: { type: 'string', maxLength: 80 },
    rfq: object({ description: { type: 'string', minLength: 1, maxLength: 2000 }, standard: nullableText, size: nullableText, grade: nullableText, finish: nullableText, quantity: { type: ['integer', 'null'], minimum: 1 }, currency: nullableText, incoterm: nullableText, destination: nullableText, targetUnitPrice: { type: ['number', 'null'], exclusiveMinimum: 0 }, maxUnitPrice: { type: ['number', 'null'], exclusiveMinimum: 0 }, requiredBy: nullableText }),
    unit: nullableText,
    evidence: { type: 'array', maxItems: 40, items: object({ field: { type: 'string', enum: [...RFQ_FIELDS] }, quote: { type: 'string', minLength: 1, maxLength: 3000 }, page: { type: 'integer', minimum: 1 } }) },
    uncertainties: strings,
  }) },
  requirements: strings, warnings: strings,
});
