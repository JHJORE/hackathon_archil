import type { RfqProvenance } from './scout.js';
import type { EmailDraft, EmailStatus, MailAccount, QuoteEvidence } from './email.js';
export type Rfq = {
  description: string; standard: string | null; size: string | null; grade: string | null; finish: string | null;
  quantity: number | null; currency: string | null; incoterm: string | null; destination: string | null;
  targetUnitPrice: number | null; maxUnitPrice: number | null; requiredBy: string | null;
};
/** Complete reviewed terms needed before creating or sending outreach. Delivery date stays optional. */
export type OutreachRfq = { [K in Exclude<keyof Rfq, 'requiredBy'>]: NonNullable<Rfq[K]> } & Pick<Rfq, 'requiredBy'>;
export type EvidencePage = {
  requestedUrl: string; url: string; title: string; markdown: string;
  extraction: string; fetchedAt: string; truncated: boolean; extractionUrl: string;
};
export type CandidateDraft = {
  companyName: string; chineseName: string | null; city: string | null; sourceUrl: string;
  publishedContacts: { emails: string[]; phones: string[] };
  technicalFit: { score: number; summary: string; standards: string[]; grades: string[]; finish: string | null };
  manufacturingEvidence: string[]; certifications: string[];
  identifiers: { uscc: string | null; icp: string | null };
  evidenceQuotes: { url: string; text: string; claim: string }[];
  uncertainties: string[];
};
export type Candidate = CandidateDraft & {
  supplierId: string;
  fingerprints: { url: string; sha256: string; fetchedAt: string; truncated: boolean }[];
  identity: { domain: string | null; phones: string[]; uscc: string | null; icp: string | null };
};
export type Quote = {
  unitPrice: number | null; currency: string | null; quantity: number | null;
  standard: string | null; size: string | null; grade: string | null; finish: string | null;
  incoterm: string | null; destination: string | null; leadTimeDays: number | null;
  notes: string[];
};
export type NegotiationResult = { quote: Quote; counterofferText: string | null; explanation: string };
export type SupplierStatus = 'awaiting reply' | 'negotiating' | 'target met' | 'needs attention' | 'closed' | 'error';
export type SupplierState = {
  supplier: Candidate; status: SupplierStatus; round: number; latestOffer: Quote | null;
  originalOffer: Quote | null; explanation: string; unread: number; nextAction: string;
};
export type CaseState = {
  id: string; createdAt: string; updatedAt: string; rfq: Rfq;
  status: 'ready' | 'researching' | 'awaiting replies' | 'negotiating' | 'complete' | 'needs attention' | 'error';
  suppliers: SupplierState[]; uncertainties: string[]; holdProcessingMs: number;
  researchComplete: boolean; researchAttempt: string | null; error: string | null;
  researchMode: 'live' | 'saved research';
  researchReplay?: { caseId: string; attemptId: string };
  communicationMode?: 'simulated' | 'email';
  emailAccount?: MailAccount;
  sourceCaseId?: string;
  rfqSource?: RfqProvenance;
};
export type Message = {
  messageId: string; caseId: string; supplierId: string; direction: 'inbound' | 'outbound';
  text: string; createdAt: string; simulated: boolean;
  email?: { providerMessageId: string; threadId: string; rfcMessageId: string; from: string; to: string[]; subject: string; inReplyTo: string | null; references: string[]; attachments: { filename: string; mimeType: string }[]; autoSubmitted: boolean; truncated: boolean };
};
export type IncomingMessage = Omit<Message, 'direction' | 'createdAt' | 'simulated'>;
export type AppEvent = {
  id: string; at: string; type: string; caseId?: string; supplierId?: string;
  message: string; data?: Record<string, unknown>;
};
export type WorkerSlot = {
  slot: number; jobId: string | null; kind: string | null; status: 'idle' | 'running' | 'completed' | 'error';
  startedAt: string | null; durationMs: number | null;
};
export type ExecJob = {
  id: string; track: string; status: 'running' | 'completed' | 'error'; startedAt: string;
  durationMs: number | null; mounts: { name: string; path: string; permission: 'readOnly' | 'conditional' }[];
  error?: string;
};
export type RuntimeSnapshot = {
  slots: WorkerSlot[]; queue: { jobId: string; kind: string; priority: number }[];
  execJobs: ExecJob[]; keenable: { searches: number; fetches: number; credits: number };
  config: { archil: boolean; keenable: boolean; model: string; storage: string };
  email?: EmailStatus;
};
export type CaseDetail = {
  state: CaseState; conversations: Record<string, Message[]>; offers: Record<string, unknown>; events: AppEvent[];
  offerHistory?: Record<string, { sourceMessageId: string; createdAt: string; quote: Quote; status: SupplierStatus; explanation: string }[]>;
  emailDrafts?: EmailDraft[];
  quoteEvidence?: Record<string, QuoteEvidence[]>;
};
export interface Store {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: unknown): Promise<void>;
  putText(key: string, text: string): Promise<void>;
  getText(key: string): Promise<string | null>;
  list(prefix: string): Promise<string[]>;
  immutable(key: string, value: unknown): Promise<void>;
}
export type ModelJob = { jobId: string; kind: string; priority: 1 | 2; schema: Record<string, unknown>; input: unknown; instructions: string };
export interface ModelGateway { run<T>(job: ModelJob): Promise<T> }
export interface EventBus { emit(type: string, message: string, data?: Record<string, unknown>, caseId?: string, supplierId?: string): AppEvent; }
export interface ResearchPipeline { run(state: CaseState): Promise<{ candidates: Candidate[]; uncertainties: string[] }>; }
