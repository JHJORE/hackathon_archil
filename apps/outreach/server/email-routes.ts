import { Router } from 'express';
import type { Orchestrator } from './orchestrator.js';
import type { MailProvider, EmailStatus } from '../shared/email.js';

const bad = (message: string) => Object.assign(new Error(message), { status: 400 });
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(value)) throw bad('Invalid identifier');
  return value;
};
const revision = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw bad('A current positive draft revision is required');
  return value;
};
export function emailRoutes(options: {
  orchestrator: Orchestrator; mail: MailProvider; ready(): void;
  refresh(): Promise<EmailStatus>;
}) {
  const router = Router();
  router.get('/email/status', async (_req, res) => res.json(await options.refresh()));
  router.post('/email/connect', async (_req, res) => {
    await options.mail.connectInbox();
    res.json(await options.refresh());
  });
  router.post('/email/sync', async (_req, res) => {
    options.ready();
    try { res.json(await options.orchestrator.syncEmail()); }
    finally { await options.refresh().catch(() => undefined); }
  });
  router.post('/cases/:id/email-outreach', async (req, res) => {
    options.ready();
    if (!Array.isArray(req.body?.supplierIds) || req.body.supplierIds.length < 1 || req.body.supplierIds.length > 3) throw bad('Select one to three suppliers');
    const supplierIds = req.body.supplierIds.map(identifier);
    if (new Set(supplierIds).size !== supplierIds.length) throw bad('Select distinct suppliers');
    const result = await options.orchestrator.prepareEmailOutreach(identifier(req.params.id), supplierIds);
    await options.refresh().catch(() => undefined);
    res.status(201).json(result);
  });
  router.patch('/cases/:id/email-drafts/:draftId', async (req, res) => {
    options.ready();
    const body = req.body;
    if (!body || typeof body.to !== 'string' || body.to.length > 320 || typeof body.subject !== 'string' || body.subject.length > 500 || /[\r\n]/.test(body.subject) || typeof body.body !== 'string' || body.body.length > 30000) throw bad('Supply recipient, a single-line subject and message within the size limits');
    const result = await options.orchestrator.editEmailDraft(identifier(req.params.id), identifier(req.params.draftId), { revision: revision(body.revision), to: body.to, subject: body.subject, body: body.body });
    await options.refresh().catch(() => undefined); res.json(result);
  });
  router.post('/cases/:id/email-drafts/:draftId/approve-send', async (req, res) => {
    options.ready();
    if (typeof req.body?.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(req.body.contentHash)) throw bad('Review the exact saved draft before approving');
    try {
      const result = await options.orchestrator.approveEmailDraft(identifier(req.params.id), identifier(req.params.draftId), { revision: revision(req.body.revision), contentHash: req.body.contentHash });
      res.json(result);
    } finally { await options.refresh().catch(() => undefined); }
  });
  return router;
}
