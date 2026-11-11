export type MailAccount = { email: string; name: string };
export type EmailConnection = {
  configured: boolean; connected: boolean; account: MailAccount | null;
  state: 'disconnected' | 'connecting' | 'connected' | 'error'; error: string | null;
};
export type EmailStatus = EmailConnection & {
  lastSyncAt: string | null; syncing: boolean; syncError: string | null; pendingApprovals: number;
};
export type OutgoingMail = {
  from: MailAccount; to: string; subject: string; body: string;
  rfcMessageId: string; threadId: string | null; inReplyTo: string | null;
  references: string[]; contentHash: string;
};
export type SendReceipt = { messageId: string; threadId: string };
export type ReceivedMail = {
  id: string; threadId: string; rfcMessageId: string; from: string; to: string[];
  subject: string; body: string; receivedAt: string; inReplyTo: string | null;
  references: string[]; autoSubmitted: boolean; truncated: boolean;
  attachments: { filename: string; mimeType: string }[]; raw: Record<string, unknown>;
};
export interface MailProvider {
  status(): Promise<EmailConnection>;
  connectInbox(): Promise<MailAccount>;
  account(): Promise<MailAccount>;
  createDraft(mail: OutgoingMail): Promise<{ draftId: string }>;
  sendDraft(draftId: string, mail: OutgoingMail): Promise<SendReceipt>;
  reconcileSent(mail: OutgoingMail): Promise<SendReceipt | null>;
  listThreadMessages(threadId: string): Promise<{ id: string; threadId: string }[]>;
  readMessage(messageId: string): Promise<ReceivedMail>;
}
export type EmailDraft = {
  id: string; caseId: string; supplierId: string; kind: 'rfq' | 'counteroffer' | 'clarification';
  revision: number; to: string; subject: string; body: string; from: MailAccount;
  contentHash: string; createdAt: string; updatedAt: string;
  status: 'pending approval' | 'sending' | 'sent' | 'send unknown' | 'failed';
  sourceMessageId: string | null; contactSourceUrl: string | null;
  rfcMessageId: string; providerThreadId: string | null; providerDraftId: string | null;
  inReplyTo: string | null; references: string[]; providerMessageId: string | null;
  approvedHash: string | null; error: string | null;
};
export type QuoteEvidence = { field: string; messageId: string; excerpt: string; packageId: string };
