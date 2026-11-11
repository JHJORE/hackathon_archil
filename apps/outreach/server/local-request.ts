import type { RequestHandler } from 'express';

// Reviewed sends must originate in this dashboard, not an unrelated website
// posting to a service listening on localhost. CLI clients can omit Origin.
export function localRequestGuard(port: number): RequestHandler {
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:4311', 'http://localhost:4311']);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (!hosts.has(req.get('host') || '') || (origin && !origins.has(origin))) return res.status(403).json({ error: 'Use the local sourcing dashboard for this request' });
    const documentUpload = req.method === 'POST' && req.path === '/api/rfq-uploads' && (req.is('application/pdf') || req.is('text/plain'));
    if (req.path.startsWith('/api/') && ['POST', 'PATCH', 'PUT'].includes(req.method) && !documentUpload && !req.is('application/json')) return res.status(415).json({ error: 'API changes require application/json, except PDF/text RFQ uploads' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  };
}
