import type { CaseState, Rfq } from './types.js';
export type RfqPage = { page: number; text: string };
export type RfqLine = {
  lineId: string;
  rfq: Rfq;
  unit: string | null;
  evidence: { field: keyof Rfq; quote: string; page: number }[];
  uncertainties: string[];
};
export type RfqExtraction = {
  title: string | null; reference: string | null; buyer: string | null; quoteDueDate: string | null;
  lines: RfqLine[]; requirements: string[]; warnings: string[];
};
export type UploadRecord = {
  id: string; filename: string; mimeType: 'application/pdf' | 'text/plain'; sha256: string;
  createdAt: string; status: 'extracting' | 'ready' | 'error'; pages: number | null;
  error: string | null; result: RfqExtraction | null;
};
export type UploadImportResult = { cases: CaseState[]; errors: string[] };
