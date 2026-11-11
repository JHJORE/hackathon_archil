import express, { Router } from 'express';
import type { Orchestrator } from './orchestrator.js';
import { RfqUploadService, MAX_UPLOAD_BYTES } from './rfq-upload.js';
import { requireResearchConnection } from './rfq-input.js';
import type { EventBus } from '../shared/types.js';
import { redact } from './codex.js';

export function rfqUploadRoutes(options: { uploads: RfqUploadService; orchestrator: Orchestrator; events: EventBus; ready: () => void }) {
  const router = Router();
  router.get('/rfq-uploads', async (_req,res) => { options.ready(); res.json({ uploads: await options.uploads.list() }); });
  router.get('/rfq-uploads/:id', async (req,res) => { options.ready(); res.json(await options.uploads.get(String(req.params.id))); });
  router.get('/rfq-uploads/:id/document', async (req,res) => {
    options.ready();
    const source = await options.uploads.document(String(req.params.id));
    res.set({ 'Content-Type':source.mimeType, 'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(source.filename)}`, 'Cache-Control':'no-store', 'Content-Security-Policy':"sandbox; default-src 'none'" });
    res.send(Buffer.from(source.base64,'base64'));
  });
  router.post('/rfq-uploads', express.raw({type:['application/pdf','text/plain'],limit:MAX_UPLOAD_BYTES}), async (req,res) => {
    options.ready();
    if (!Buffer.isBuffer(req.body)) return res.status(415).json({error:'Upload a PDF or UTF-8 text document as the request body.'});
    let filename: string;
    try { filename = decodeURIComponent(req.get('X-File-Name') || ''); } catch { return res.status(400).json({error:'Invalid document filename.'}); }
    const mimeType = (req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    res.status(202).json(await options.uploads.submit(req.body,filename,mimeType));
  });
  router.post('/rfq-uploads/:id/import', async (req,res) => {
    options.ready();
    if (typeof req.body?.start !== 'boolean') return res.status(400).json({error:'Choose whether to start supplier research.'});
    const result = await options.uploads.importLines(String(req.params.id),req.body.lineIds,options.orchestrator);
    if (req.body.start) for (const state of result.cases) {
      try {
        requireResearchConnection(state,process.env.KEENABLE_API_KEY);
        void options.orchestrator.start(state.id).catch(error => options.events.emit('case.error',redact(error.message),{},state.id));
      } catch(error) { result.errors.push(redact((error as Error).message)); }
    }
    res.status(201).json({...result,errors:[...new Set(result.errors)]});
  });
  return router;
}
