// Voice buyer-finder server.
// Serves public/index.html and routes /api/<name> to api/<name>.mjs.
//   npm start   -> http://localhost:4320
import "dotenv/config";
import http from "node:http";
import fs from "node:fs/promises";
import { Readable } from "node:stream";

const PORT = Number(process.env.VOICE_PORT || 4320);
const routes = {};
for (const f of await fs.readdir(new URL("./api/", import.meta.url))) {
  if (f.endsWith(".mjs")) routes[`/api/${f.replace(/\.mjs$/, "")}`] = await import(`./api/${f}`);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const mod = routes[url.pathname];
  if (mod) {
    const handler = mod[req.method];
    if (!handler) { res.statusCode = 405; return res.end(); }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);
    const webReq = new Request(url, { method: req.method, headers: req.headers, body, duplex: "half" });
    const out = await handler(webReq);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    if (out.body) Readable.fromWeb(out.body).pipe(res); else res.end();
    return;
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (!/^[\w-]+\.html$/.test(file)) { res.statusCode = 404; return res.end("not found"); }
  try {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(await fs.readFile(new URL(`./public/${file}`, import.meta.url)));
  } catch { res.statusCode = 404; res.end("not found"); }
}).listen(PORT, () => console.log(`Voice buyer finder on http://localhost:${PORT}`));
