import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ScoutItem } from '../shared/scout.js';
import { parseRfq } from './rfq-input.js';

export const DOCUMENT_ID = 'document-demo-fasteners';
const documentPath = new URL('../data/rfqs/demo-fasteners.json', import.meta.url);
/** Public example only. Real buyer documents and private runtime data are not bundled. */
export async function rfqDocument(): Promise<{ item: ScoutItem; raw: string }> {
  const bytes = await readFile(documentPath);
  const raw = bytes.toString('utf8');
  const sample = JSON.parse(raw);
  const rfq = parseRfq(sample.rfq);
  if (!rfq || sample.fictional !== true) throw new Error('The bundled demonstration RFQ is invalid.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const item: ScoutItem = {
    id: DOCUMENT_ID, title: 'Fictional RFQ · 50,000 cap screws', reference: 'DEMO-FASTENERS-001', buyer: 'Fictional demo buyer', dueDate: null,
    sourceUrl: `/api/scout/items/${DOCUMENT_ID}/document`,
    summary: 'ISO 4762 M8x30 · Grade 12.9 · Black oxide · CIF Oakland. Demonstration requirements and prices only.',
    rfq,
    warnings: [
      'This is a fictional example, not an active buyer request or a supplier quotation.',
      'The USD 0.065 target and USD 0.082 maximum are fictional demonstration prices. Enter your own verified buying requirements for real sourcing.',
      'The delivery deadline remains unresolved. The app does not place orders or accept offers.',
    ],
    source: { id: DOCUMENT_ID, kind: 'document', diskId: null, diskName: null, path: 'demo-fasteners.json', sha256, revision: 'Fictional sample v1' },
  };
  return { item, raw };
}
export async function rfqDocumentBytes() { return readFile(documentPath); }
