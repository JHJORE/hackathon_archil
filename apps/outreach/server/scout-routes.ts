import { Router } from 'express';
import type { ScoutItem, ScoutOverview } from '../shared/scout.js';
import type { Orchestrator } from './orchestrator.js';
import { parseRfq } from './rfq-input.js';
import { DOCUMENT_ID, rfqDocument, rfqDocumentBytes } from './rfq-document.js';

type ScoutReader = { overview(): Promise<ScoutOverview>; resolve(id: string): Promise<{ item: ScoutItem; raw: string }> };
const invalid = (message: string, status = 400) => Object.assign(new Error(message), { status });
export function scoutRoutes(options: { scout: ScoutReader; orchestrator: Orchestrator; ready: () => void }) {
  const router = Router();
  const resolve = (id: string) => id === DOCUMENT_ID ? rfqDocument() : options.scout.resolve(id);
  router.get('/scout', async (_req, res) => {
    const [overview, document] = await Promise.all([options.scout.overview(), rfqDocument()]);
    res.json({ ...overview, items: [document.item, ...overview.items] });
  });
  router.get('/scout/items/:id', async (req, res) => res.json((await resolve(String(req.params.id))).item));
  router.get('/scout/items/:id/document', async (req, res) => {
    if (req.params.id !== DOCUMENT_ID) throw invalid('Document not found', 404);
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'inline; filename="demo-fasteners.json"' }).send(await rfqDocumentBytes());
  });
  router.post('/scout/import', async (req, res) => {
    options.ready();
    const source = req.body?.source;
    if (!source || typeof source.id !== 'string' || !/^[a-zA-Z0-9_-]{1,180}$/.test(source.id) || typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) throw invalid('Choose a current RFQ source before importing.');
    const rfq = parseRfq(req.body?.rfq);
    if (!rfq) throw invalid('Complete the RFQ requirements before importing.');
    const current = await resolve(source.id);
    if (current.item.source.sha256 !== source.sha256) throw invalid('The source changed since your review. Refresh the RFQ and review its current revision.', 409);
    res.status(201).json(await options.orchestrator.importRfq(current.item, current.raw, rfq));
  });
  return router;
}
