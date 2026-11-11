import type { Rfq } from './types.js';

export type ScoutSource = {
  id: string;
  kind: 'archil' | 'document';
  diskId: string | null;
  diskName: string | null;
  path: string;
  sha256: string;
  revision: string | null;
};
export type ScoutItem = {
  id: string;
  title: string;
  reference: string | null;
  buyer: string | null;
  dueDate: string | null;
  sourceUrl: string | null;
  summary: string;
  rfq: Partial<Rfq>;
  warnings: string[];
  source: ScoutSource;
};
export type ScoutOverview = {
  checkedAt: string;
  disk: { id: string; name: string; connected: boolean; access: 'read-only' };
  items: ScoutItem[];
  error: string | null;
  limited: boolean;
};
export type ScoutReview = {
  rfq: Partial<Rfq>;
  source: { id: string; sha256: string };
  title: string;
  warnings: string[];
};
export type RfqProvenance = ScoutSource & { title: string; importedAt: string; warnings: string[]; snapshotKey?: string; snapshotSha256?: string };
