// Per-buyer actions.
//   POST /api/call {campaign_id, buyer_id, action: "script"}         write the personalized call guide
//   POST /api/call {campaign_id, buyer_id, action: "call", approved: true, live?: true}
//        places the ElevenLabs call. Demo mode (default) rings DEMO_CALL_NUMBER; live mode
//        rings the buyer and also requires LIVE_CALLS_ENABLED=1 on the server.
//   GET  /api/call?campaign_id=..&conversation_id=..                 transcript + guardrail audit
import { openStore } from "../lib/store.mjs";
import { writeScript, placeCall, fetchAndAudit, startWebSession, recordWebCall } from "../lib/calls.mjs";
import { authorized, publicBaseUrl } from "../lib/auth.mjs";

async function load(store, campaignId, buyerId) {
  const campaign = JSON.parse((await store.get(`campaigns/${campaignId}/campaign.json`)) || "null");
  const buyer = buyerId ? JSON.parse((await store.get(`campaigns/${campaignId}/buyers/${buyerId}.json`)) || "null") : null;
  return { campaign, buyer };
}

export async function POST(req) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });
  const b = await req.json().catch(() => ({}));
  try {
    const store = await openStore();
    const { campaign, buyer } = await load(store, b.campaign_id, b.buyer_id);
    if (!campaign || !buyer) return Response.json({ error: "campaign or buyer not found" }, { status: 404 });
    const scriptKey = `campaigns/${campaign.id}/scripts/${buyer.id}.json`;
    let script = JSON.parse((await store.get(scriptKey)) || "null");

    if (b.action === "script" || !script) {
      script = { buyer_id: buyer.id, ...(await writeScript(campaign, buyer)) };
      await store.put(scriptKey, JSON.stringify(script, null, 2));
      if (b.action === "script") return Response.json({ script });
    }
    if (b.action === "web") {
      if (b.approved !== true) return Response.json({ error: "every call needs explicit approval" }, { status: 400 });
      return Response.json(await startWebSession({ store, campaign, buyer, script, baseUrl: publicBaseUrl() }));
    }
    if (b.action === "web-started" && b.conversation_id) {
      return Response.json({ call: await recordWebCall({ store, campaign, buyer, conversationId: b.conversation_id }) });
    }
    if (b.action === "call") {
      if (b.approved !== true) return Response.json({ error: "every call needs explicit approval" }, { status: 400 });
      const call = await placeCall({ store, campaign, buyer, script, baseUrl: publicBaseUrl(), live: b.live === true });
      return Response.json({ call });
    }
    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function GET(req) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });
  const u = new URL(req.url).searchParams;
  try {
    const store = await openStore();
    const { campaign } = await load(store, u.get("campaign_id"));
    if (!campaign) return Response.json({ error: "campaign not found" }, { status: 404 });
    return Response.json({ call: await fetchAndAudit({ store, campaign, conversationId: u.get("conversation_id") }) });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
