import type { Message, Quote } from '../shared/types.js';
import type { QuoteEvidence } from '../shared/email.js';
import { negotiationSchema } from './negotiation-schema.js';
import { validateOutput } from './schema.js';

export type EmailExtraction = {
  quote: Quote; packageId: string | null; alternatives: boolean; conditional: boolean;
  evidence: QuoteEvidence[]; explanation: string; clarificationQuestions: string[];
  confirmation: { messageId: string; excerpt: string; confirmsMessageId: string } | null;
};
export const emailNegotiationSchema: Record<string, unknown> = {
  type: 'object', additionalProperties: false,
  properties: {
    quote: (negotiationSchema.properties as Record<string, unknown>).quote,
    packageId: { type: ['string', 'null'] }, alternatives: { type: 'boolean' }, conditional: { type: 'boolean' },
    evidence: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      field: { type: 'string' }, messageId: { type: 'string' }, excerpt: { type: 'string' }, packageId: { type: 'string' },
    }, required: ['field', 'messageId', 'excerpt', 'packageId'] } },
    explanation: { type: 'string' }, clarificationQuestions: { type: 'array', items: { type: 'string' } },
    confirmation: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: {
      messageId: { type: 'string' }, excerpt: { type: 'string' }, confirmsMessageId: { type: 'string' },
    }, required: ['messageId', 'excerpt', 'confirmsMessageId'] }] },
  }, required: ['quote', 'packageId', 'alternatives', 'conditional', 'evidence', 'explanation', 'clarificationQuestions', 'confirmation'],
};

export function authoredText(text: string): string {
  const lines: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^(?:On .+wrote:|[- ]{2,}Original Message[- ]*|From:\s)/i.test(line.trim())) break;
    if (!/^\s*>/.test(line)) lines.push(line);
  }
  return lines.join('\n').trim();
}
function containsValue(value: string | number, excerpt: string): boolean {
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(value)) {
    const tokens = excerpt.match(/(?<![\d.])[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?!\d|\.\d)/g) ?? [];
    return tokens.some(token => Number(token.replace(/,/g, '')) === Number(value));
  }
  const escaped = value.trim().replace(/×/g, 'x').replace(/[\s-]+/g, '').split('').map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s-]*');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(excerpt.replace(/×/g, 'x'));
}

/** Ground one coherent package; unsupported values become unknown rather than borrowing RFQ values. */
export function groundEmailExtraction(value: unknown, inbound: Message, history: Message[]): { result: EmailExtraction; evidence: QuoteEvidence[]; issues: string[] } {
  const result = structuredClone(validateOutput<EmailExtraction>(emailNegotiationSchema, value));
  const sources = new Map([...history.filter(m => m.direction === 'inbound' && !m.simulated), inbound].map(m => [m.messageId, authoredText(m.text)]));
  const issues: string[] = [];
  const confirmation = result.confirmation;
  const currentText = authoredText(inbound.text);
  const uncertain = /\b(?:cannot|can't|not|unable|unconfirmed|except|unless|if|subject to|pending|depending|indicative|estimated)\b|如果|取决于|仅供参考/i;
  const affirmative = /\b(?:all (?:other )?(?:terms|specifications|specs|conditions)(?: and (?:terms|specifications|specs|conditions))? (?:remain |are )?(?:unchanged|the same)|(?:we )?(?:hereby )?confirm (?:all |the |our )?(?:previous|prior|original|previously quoted) (?:offer|terms|specifications))\b/i;
  const confirmsPrior = confirmation?.messageId === inbound.messageId && confirmation.excerpt.trim().length > 0
    && currentText.includes(confirmation.excerpt) && sources.has(confirmation.confirmsMessageId)
    && confirmation.confirmsMessageId !== inbound.messageId
    && !uncertain.test(currentText) && affirmative.test(confirmation.excerpt);
  const evidence: QuoteEvidence[] = [];
  for (const field of Object.keys(result.quote).filter(k => k !== 'notes') as Exclude<keyof Quote, 'notes'>[]) {
    const quoted = result.quote[field];
    if (quoted === null) continue;
    const support = result.evidence.find(e => e.field === field && e.packageId === result.packageId && !!e.packageId
      && e.excerpt.trim().length > 0 && sources.get(e.messageId)?.includes(e.excerpt)
      && (e.messageId === inbound.messageId || (confirmsPrior && e.messageId === confirmation?.confirmsMessageId))
      && containsValue(quoted, e.excerpt));
    if (support) evidence.push(support);
    else { (result.quote as unknown as Record<string, unknown>)[field] = null; issues.push(`No unambiguous supplier-authored evidence for ${field}.`); }
  }
  if (result.alternatives) issues.push('The supplier presented alternative offer packages; a single package must be confirmed.');
  if (result.conditional) issues.push('The offer is conditional; its outstanding conditions need clarification.');
  if (/\b(?:subject to|provided that|depending on|indicative|estimated|option [ab12]|alternative offer)\b|如果|取决于|仅供参考|方案[一二12AB]/i.test(currentText)) issues.push('Supplier wording includes a condition or alternative requiring clarification.');
  if (/\b(?:unavailable|not available|cannot supply|can't supply|instead|only (?:supply|offer|provide|grade)|substitute (?:grade|material|finish))\b|无法提供|缺货|替代材料/i.test(currentText)) issues.push('Supplier wording rejects availability or proposes a substitution; confirm the requested specification before negotiating.');
  if (!result.packageId) issues.push('No coherent offer package was identified.');
  return { result, evidence, issues };
}
