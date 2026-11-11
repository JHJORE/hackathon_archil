// Webhook tool the ElevenLabs voice agent must call before saying any price.
// Refuses anything below the seller's quoted price (the floor) and logs every check.
import { openStore } from "../lib/store.mjs";
import { checkPrice } from "../lib/calls.mjs";

export async function POST(req) {
  if (process.env.VOICE_ACCESS_KEY && req.headers.get("x-voice-key") !== process.env.VOICE_ACCESS_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }
  const b = await req.json().catch(() => ({}));
  const store = await openStore();
  const campaign = JSON.parse((await store.get(`campaigns/${b.campaign_id}/campaign.json`)) || "null");
  if (!campaign) return Response.json({ allowed: false, say: "Pricing is unavailable; offer to send a written quote instead." });
  const result = checkPrice(campaign, b.proposed_price, b.buyer_committed_volume === true);
  await store.append(`campaigns/${campaign.id}/price-checks.jsonl`, JSON.stringify({
    at: new Date().toISOString(), buyer_id: b.buyer_id, conversation_id: b.conversation_id,
    proposed: b.proposed_price, committed: b.buyer_committed_volume, allowed: result.allowed,
  }) + "\n");
  return Response.json(result);
}
