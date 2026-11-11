// Seller campaigns: upload a spec sheet -> product profile -> buyer-finding swarm -> top 10.
//   POST /api/campaigns  {filename, pdf_base64 | spec_text, quoted_price, list_price?, unit?, company, rep_name}
//                        streams the swarm log; last line is "CAMPAIGN <id>"
//   GET  /api/campaigns            list campaigns
//   GET  /api/campaigns?id=<id>    campaign, buyers, scripts, calls
// Everything is stored on the shared Archil disk under campaigns/<id>/.
import crypto from "node:crypto";
import { openStore } from "../lib/store.mjs";
import { extractProduct } from "../lib/product.mjs";
import { runBuyerSwarm } from "../lib/buyers.mjs";
import { priceLadder } from "../lib/calls.mjs";
import { authorized } from "../lib/auth.mjs";

const readDir = async (store, prefix) => {
  const keys = (await store.list(prefix)).filter((k) => k.endsWith(".json"));
  return (await Promise.all(keys.map(async (k) => JSON.parse(await store.get(k))))).filter(Boolean);
};

export async function GET(req) {
  const store = await openStore();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    const dirs = await store.list("campaigns");
    const list = (await Promise.all(dirs.map(async (d) => JSON.parse((await store.get(`${d}/campaign.json`)) || "null")))).filter(Boolean);
    list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return Response.json({ campaigns: list.map((c) => ({ id: c.id, product: c.product?.product_name, created_at: c.created_at, buyers: c.top_buyers?.length || 0 })) });
  }
  const campaign = JSON.parse((await store.get(`campaigns/${id}/campaign.json`)) || "null");
  if (!campaign) return Response.json({ error: "not found" }, { status: 404 });
  const [buyers, scripts, calls] = await Promise.all([
    readDir(store, `campaigns/${id}/buyers`), readDir(store, `campaigns/${id}/scripts`), readDir(store, `campaigns/${id}/calls`),
  ]);
  const ladder = priceLadder(campaign.pricing);
  return Response.json({ campaign: { ...campaign, ladder: { list: ladder.list, step2: ladder.step2, step3: ladder.step3, floor: ladder.floor } }, buyers, scripts, calls });
}

export async function POST(req) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });
  const body = await req.json().catch(() => ({}));
  const quoted = Number(body.quoted_price);
  if (!(quoted > 0)) return new Response("quoted_price is required", { status: 400 });
  if (!body.pdf_base64 && !body.spec_text) return new Response("upload a PDF or paste the spec text", { status: 400 });

  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      const log = (l) => controller.enqueue(enc.encode(l + "\n"));
      try {
        const store = await openStore();
        const id = `c-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString("hex")}`;
        const pdf = body.pdf_base64 ? Buffer.from(body.pdf_base64, "base64") : null;
        if (pdf) await store.put(`campaigns/${id}/spec.pdf`, pdf);
        log(`Campaign ${id} | store: ${store.kind}`);
        log(`[1/3] Reading the spec sheet with Claude...`);
        const product = await extractProduct({ pdf, text: body.spec_text, filename: body.filename });
        log(`      ${product.product_name} — ${product.category}`);
        log(`      typical buyers: ${product.typical_buyers.join(", ")}`);
        const campaign = {
          id, created_at: new Date().toISOString(), filename: body.filename || null,
          seller: { company: body.company || product.seller || "our company", rep_name: body.rep_name || "Alex" },
          pricing: {
            quoted_price: quoted,
            list_price: Number(body.list_price) || null,
            unit: body.unit || product.unit_of_sale || "per unit",
            currency: "USD",
            delivery: "excluded — ex-works / FOB origin; delivery and freight quoted separately and settled last",
          },
          product,
        };
        await store.put(`campaigns/${id}/campaign.json`, JSON.stringify(campaign, null, 2));
        log(`\n[2/3] Buyer swarm: searching for organizations that need this product...`);
        const top = await runBuyerSwarm({ store, campaign, log, budgetMs: 200_000 });
        campaign.top_buyers = top.map((b) => b.id);
        await store.put(`campaigns/${id}/campaign.json`, JSON.stringify(campaign, null, 2));
        log(`\n[3/3] Top ${top.length} buyers saved. Generate a script and approve each call on the campaign page.`);
        log(`CAMPAIGN ${id}`);
      } catch (e) {
        log(`ERROR: ${e.message}`);
      }
      controller.close();
    },
  }), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
