import { createHash } from 'node:crypto';
import { findPhoneNumbersInText, parsePhoneNumberFromString } from 'libphonenumber-js';
import { getDomain } from 'tldts';
import type { Candidate, CandidateDraft, EvidencePage, Rfq } from '../shared/types.js';

export const EXCLUDED_DOMAINS = [
  'alibaba.com', '1688.com', 'made-in-china.com', 'globalsources.com', 'hc360.com',
  'huangye88.com', 'china.cn', 'qcc.com', 'tianyancha.com', 'thomasnet.com',
] as const;

export function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function manufacturerDomain(value: string): string | null {
  const url = canonicalUrl(value);
  if (!url) return null;
  const host = new URL(url).hostname.toLowerCase();
  if (EXCLUDED_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`))) return null;
  return getDomain(host, { allowPrivateDomains: true });
}

export function fingerprint(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex');
}

export function normalizePhone(value: string): string | null {
  try {
    const phone = parsePhoneNumberFromString(value.normalize('NFKC'), { defaultCountry: 'CN', extract: false });
    return phone?.isValid() ? phone.number : null;
  } catch { return null; }
}

function rawPhones(text: string): Set<string> {
  return new Set(findPhoneNumbersInText(text.normalize('NFKC'), 'CN')
    .filter(match => match.number.isValid()).map(match => match.number.number));
}

function rawEmails(text: string): Set<string> {
  return new Set((text.normalize('NFKC').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi) ?? [])
    .map(email => email.toLowerCase()));
}

function presentToken(value: string, raw: string): boolean {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  // Do not ground grade 8.8 from 18.8, or ISO 9001 from ISO 90010.
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(normalizeText(raw));
}

export type GroundingResult = { candidates: Candidate[]; uncertainties: string[]; rejected: { companyName: string; reason: string }[] };

/** Only raw page markdown is evidence; extraction answers and search snippets are never proof. */
export function verifyCandidates(drafts: CandidateDraft[], pages: EvidencePage[], rfq: Rfq): GroundingResult {
  const candidates: Candidate[] = [];
  const uncertainties: string[] = [];
  const rejected: GroundingResult['rejected'] = [];
  for (const draft of drafts) {
    const sourceKey = canonicalUrl(draft.sourceUrl);
    const sourcePage = pages.find(page => canonicalUrl(page.url) === sourceKey || canonicalUrl(page.requestedUrl) === sourceKey);
    const domain = sourcePage ? manufacturerDomain(sourcePage.url) : null;
    if (!sourcePage || !domain) {
      rejected.push({ companyName: draft.companyName, reason: 'Source is not a fetched manufacturer page.' });
      continue;
    }
    const ownPages = pages.filter(page => manufacturerDomain(page.url) === domain);
    const raw = ownPages.map(page => page.markdown).join('\n');
    const normalized = normalizeText(raw);
    const companyPresent = draft.companyName.trim().length >= 3 && normalized.includes(normalizeText(draft.companyName));
    const chinesePresent = Boolean(draft.chineseName && draft.chineseName.trim().length >= 2 && normalized.includes(normalizeText(draft.chineseName)));
    if (!companyPresent && !chinesePresent) {
      rejected.push({ companyName: draft.companyName, reason: 'Company identity is not present in the raw pages.' });
      continue;
    }
    const notes = [...draft.uncertainties];
    if (!companyPresent) notes.push('The English company name is a model translation; only the Chinese name appears in the source.');
    const evidenceQuotes = draft.evidenceQuotes.flatMap(quote => {
      const quotedUrl = canonicalUrl(quote.url);
      const page = ownPages.find(item => canonicalUrl(item.url) === quotedUrl || canonicalUrl(item.requestedUrl) === quotedUrl);
      if (!page || normalizeText(quote.text).length < 8 || !normalizeText(page.markdown).includes(normalizeText(quote.text))) {
        notes.push('An unsupported quotation was removed.'); return [];
      }
      return [{ ...quote, url: page.url,
        claim: normalizeText(page.markdown).includes(normalizeText(quote.claim))
          ? quote.claim : 'Published source excerpt; interpretation requires review.' }];
    });
    if (evidenceQuotes.length === 0) {
      rejected.push({ companyName: draft.companyName, reason: 'No quotation could be verified against raw manufacturer pages.' });
      continue;
    }
    const knownEmails = rawEmails(raw);
    const knownPhones = rawPhones(raw);
    const emails = [...new Set(draft.publishedContacts.emails.map(value => value.trim().toLowerCase()).filter(value => knownEmails.has(value)))];
    const phones = [...new Set(draft.publishedContacts.phones.map(normalizePhone).filter((value): value is string => Boolean(value && knownPhones.has(value))))];
    if (emails.length < draft.publishedContacts.emails.length || phones.length < draft.publishedContacts.phones.length) {
      notes.push('Unverified contact details were removed; contacts must appear in raw source text.');
    }
    if (emails.length + phones.length === 0) notes.push('No published contact was verified in the fetched pages.');
    const supported = (values: string[], field: string) => {
      const kept = [...new Set(values.filter(value => presentToken(value, raw)))];
      if (kept.length < values.length) notes.push(`Unsupported ${field} claims were removed.`);
      return kept;
    };
    const standards = supported(draft.technicalFit.standards, 'standard');
    const grades = supported(draft.technicalFit.grades, 'grade');
    const finish = draft.technicalFit.finish && presentToken(draft.technicalFit.finish, raw) ? draft.technicalFit.finish : null;
    const manufacturingEvidence = draft.manufacturingEvidence.filter(value => normalizeText(value).length >= 8 && normalized.includes(normalizeText(value)));
    const certifications = supported(draft.certifications, 'certification');
    if (manufacturingEvidence.length === 0) notes.push('Manufacturer status remains unverified; no direct manufacturing statement survived grounding.');
    if (certifications.length > 0) notes.push('Certifications are website claims, not independently verified certificates.');
    const usccValue = draft.identifiers.uscc?.normalize('NFKC').toUpperCase().replace(/\s+/g, '') ?? null;
    const uscc = usccValue && /^[0-9A-HJ-NPQRTUWXY]{18}$/.test(usccValue) && presentToken(usccValue, raw) ? usccValue : null;
    const icpValue = draft.identifiers.icp?.normalize('NFKC').replace(/\s+/g, '') ?? null;
    const icp = icpValue && /ICP备\d{6,}(?:号(?:-\d+)?)?/u.test(icpValue) && normalizeText(raw).replace(/\s+/g, '').includes(icpValue.toLowerCase()) ? icpValue : null;
    const required = [rfq.standard, rfq.grade, rfq.finish, rfq.size].filter(Boolean);
    const matched = required.filter(value => presentToken(value, raw));
    const ceiling = required.length ? Math.round(100 * matched.length / required.length) : 50;
    const fitSummary = `Published text matches ${matched.length}/${required.length} requested technical terms${matched.length ? `: ${matched.join(', ')}` : ''}. Exact product, quantity, price and delivery require supplier confirmation.`;
    notes.push('Public website matches are sourcing leads; exact specification, availability, MOQ and quote need supplier confirmation.');
    if (ownPages.some(page => page.truncated)) notes.push('At least one source page was truncated; missing information is unknown.');
    const fingerprints = ownPages.map(page => ({ url: page.url, sha256: fingerprint(page.markdown), fetchedAt: page.fetchedAt, truncated: page.truncated }));
    const identityKey = uscc ? `uscc:${uscc}` : `${domain}|${normalizeText(chinesePresent ? draft.chineseName! : draft.companyName)}|${phones[0] ?? ''}`;
    candidates.push({
      ...draft,
      companyName: companyPresent ? draft.companyName : draft.chineseName!,
      chineseName: chinesePresent ? draft.chineseName : null,
      city: draft.city && normalized.includes(normalizeText(draft.city)) ? draft.city : null,
      sourceUrl: sourcePage.url,
      publishedContacts: { emails, phones },
      technicalFit: { score: Math.min(ceiling, Math.max(0, draft.technicalFit.score)), summary: fitSummary, standards, grades, finish },
      manufacturingEvidence, certifications, identifiers: { uscc, icp }, evidenceQuotes,
      uncertainties: [...new Set(notes)],
      supplierId: `supplier-${fingerprint(identityKey).slice(0, 16)}`,
      fingerprints, identity: { domain, phones, uscc, icp },
    });
  }
  if (rejected.length) uncertainties.push(`${rejected.length} candidate(s) rejected because raw source evidence could not substantiate them.`);
  return { candidates, uncertainties, rejected };
}

/** Names alone, domains alone, or one shared phone are insufficient to merge suppliers. */
export function sameSupplier(a: Candidate, b: Candidate): boolean {
  if (a.identity.uscc && b.identity.uscc) return a.identity.uscc === b.identity.uscc;
  if (a.identity.icp && b.identity.icp && a.identity.icp !== b.identity.icp) return false;
  if (a.chineseName && b.chineseName && normalizeText(a.chineseName) !== normalizeText(b.chineseName)) return false;
  const sameName = normalizeText(a.companyName) === normalizeText(b.companyName)
    || Boolean(a.chineseName && b.chineseName && normalizeText(a.chineseName) === normalizeText(b.chineseName));
  const sameDomain = Boolean(a.identity.domain && a.identity.domain === b.identity.domain);
  const samePhone = a.identity.phones.some(phone => b.identity.phones.includes(phone));
  const sameIcp = Boolean(a.identity.icp && a.identity.icp === b.identity.icp);
  // Name+city is supporting metadata only; both can be inaccurate translations.
  return sameName && [sameDomain, samePhone, sameIcp].filter(Boolean).length >= 2;
}

export function deduplicateCandidates(candidates: Candidate[]): { candidates: Candidate[]; uncertainties: string[] } {
  const groups: Candidate[][] = [];
  const uncertainties: string[] = [];
  for (const candidate of candidates) {
    // Require agreement with every group member, preventing a weak transitive bridge.
    const group = groups.find(items => items.every(item => sameSupplier(item, candidate)));
    if (group) group.push(candidate); else groups.push([candidate]);
  }
  const result = groups.map(group => {
    const sorted = [...group].sort((a, b) => b.technicalFit.score - a.technicalFit.score || a.sourceUrl.localeCompare(b.sourceUrl));
    const preferred = sorted[0]!;
    if (group.length === 1) return preferred;
    const fingerprints = [...new Map(group.flatMap(item => item.fingerprints).map(item => [`${item.url}|${item.sha256}`, item])).values()];
    return { ...preferred, fingerprints,
      publishedContacts: { emails: [...new Set(group.flatMap(item => item.publishedContacts.emails))], phones: [...new Set(group.flatMap(item => item.publishedContacts.phones))] },
      identity: { ...preferred.identity, phones: [...new Set(group.flatMap(item => item.identity.phones))] },
      evidenceQuotes: [...new Map(group.flatMap(item => item.evidenceQuotes).map(item => [`${item.url}|${item.text}`, item])).values()],
      uncertainties: [...new Set(group.flatMap(item => item.uncertainties))],
    };
  });
  for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) {
    const a = result[i]!, b = result[j]!;
    if (a.identity.domain === b.identity.domain || normalizeText(a.companyName) === normalizeText(b.companyName)) {
      uncertainties.push(`Possible duplicate: ${a.companyName} / ${b.companyName}; insufficient independent identity evidence to merge.`);
    }
  }
  // A conservative non-merge may still have the same deterministic base ID. Keep IDs unique.
  const counts = new Map<string, number>();
  for (const item of result) {
    const count = counts.get(item.supplierId) ?? 0;
    counts.set(item.supplierId, count + 1);
    if (count) item.supplierId += `-${count + 1}`;
  }
  return { candidates: result, uncertainties };
}
