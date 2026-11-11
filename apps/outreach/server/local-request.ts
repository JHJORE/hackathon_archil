import type { RequestHandler } from 'express';

// Reviewed sends must originate in this dashboard, not an unrelated website
// posting to a service listening on localhost. CLI clients can omit Origin.
export function localRequestGuard(port: number): RequestHandler {
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:4311', 'http://localhost:4311']);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (!hosts.has(req.get('host') || '') || (origin && !origins.has(origin))) return res.status(403).json({ error: 'Use the local sourcing dashboard for this request' });
    if (req.path.startsWith('/api/') && ['POST', 'PATCH', 'PUT'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'API changes require application/json' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  };
}
