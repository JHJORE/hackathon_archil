const text = { type: 'string' };
const nullableText = { type: ['string', 'null'] };
const strings = { type: 'array', items: text };
function object(properties: Record<string, unknown>) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

export const candidateDraftSchema = object({
  companyName: text, chineseName: nullableText, city: nullableText, sourceUrl: text,
  publishedContacts: object({ emails: strings, phones: strings }),
  technicalFit: object({ score: { type: 'number', minimum: 0, maximum: 100 }, summary: text,
    standards: strings, grades: strings, finish: nullableText }),
  manufacturingEvidence: strings, certifications: strings,
  identifiers: object({ uscc: nullableText, icp: nullableText }),
  evidenceQuotes: { type: 'array', items: object({ url: text, text, claim: text }) },
  uncertainties: strings,
});

export const researchSynthesisSchema = object({
  candidates: { type: 'array', items: candidateDraftSchema, maxItems: 5 },
  uncertainties: strings,
});

export const evaluatorSchema = object({
  // Codex strict structured outputs do not accept uniqueItems; the evaluator
  // consumer deduplicates IDs and restricts them to the grounded candidate set.
  selectedSupplierIds: { type: 'array', items: text, maxItems: 3 },
  uncertainties: strings,
});
