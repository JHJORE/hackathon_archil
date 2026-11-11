// Personalized call scripts, price guardrails and ElevenLabs outbound calls.
//
// Guardrails (enforced in code, not just in the prompt):
//  1. Floor price = the seller's quoted price. The voice agent must call the price_check
//     webhook before saying any number; numbers below the floor are refused server-side.
//  2. Every price is ex-works / FOB origin. Delivery and freight are excluded and only
//     settled last, in the written quote. The agent may not offer or discount delivery.
//  3. AI disclosure in the first sentence, opt-out honoured (do-not-call list on disk).
//  4. No call without an explicit approval click. Demo mode (default) rings DEMO_CALL_NUMBER
//     instead of the buyer; live calls need LIVE_CALLS_ENABLED=1 on the server.
//  5. Every transcript is audited after the call; violations are flagged on the disk.
import { generateText, Output } from "ai";
import { z } from "zod";
import { llm } from "./llm.mjs";

const EL = "https://api.elevenlabs.io/v1";
const elHeaders = () => ({ "xi-api-key": process.env.ELEVENLABS_API_KEY, "content-type": "application/json" });
const money = (n) => Math.round(n * 100) / 100;

// ---------- pricing ----------
export function priceLadder(pricing) {
  const floor = Number(pricing.quoted_price);
  const list = Number(pricing.list_price) || money(floor * 1.12);
  const gap = list - floor;
  return { list, step2: money(list - gap * 0.4), step3: money(list - gap * 0.75), floor };
}

export function checkPrice(campaign, proposed, buyerCommitted) {
  const l = priceLadder(campaign.pricing);
  const p = Number(proposed);
  const unit = campaign.pricing.unit || campaign.product.unit_of_sale;
  if (!Number.isFinite(p)) return { allowed: false, say: "Please call price_check with a numeric price." };
  if (p < l.floor) {
    const best = buyerCommitted ? l.floor : l.step3;
    return {
      allowed: false,
      best_authorized_price: best,
      say: `Do NOT say ${p}. Tell them that is below what you are authorized to offer. The best you may offer right now is ${best} ${unit}, ex-works, delivery quoted separately.`,
    };
  }
  return {
    allowed: true,
    best_authorized_price: buyerCommitted ? l.floor : l.step3,
    say: `You may offer ${p} ${unit}, ex-works / FOB origin, delivery and freight quoted separately at the end.`,
  };
}

// ---------- scripts ----------
const ScriptSchema = z.object({
  first_message: z.string().describe("opening line, max 2 sentences: greet the contact by name, say you are an AI assistant calling for the seller, and ask if they have a minute"),
  personalization_hooks: z.array(z.string()).describe("3-4 specific facts about this buyer to weave in (their RFQ, project, past purchases, location)"),
  call_brief: z.string().describe("the full call guide for the voice agent in markdown: context on the buyer, goal, 3 talking points tied to their need, 3 discovery questions (quantity, timing, current supplier), objection handling, price approach using the ladder, and the close (agree to send a formal written quote, confirm email)"),
  voicemail_message: z.string().describe("20-second voicemail, includes AI disclosure and a callback request"),
});

export async function writeScript(campaign, buyer) {
  const l = priceLadder(campaign.pricing);
  const p = campaign.product;
  const unit = campaign.pricing.unit || p.unit_of_sale;
  const { output } = await generateText({
    model: llm(),
    output: Output.object({ schema: ScriptSchema }),
    system: "You write short, hyper-personalized B2B outbound call guides for an AI voice agent. Specific beats generic: reference the buyer's actual RFQ, project or purchase history. Never invent facts.",
    prompt:
      `SELLER: ${campaign.seller.company} (rep name for the call: ${campaign.seller.rep_name})\n` +
      `PRODUCT: ${p.product_name} — ${p.summary}\nSpecs: ${p.key_specs.map((s) => `${s.name}: ${s.value}`).join("; ")}\n` +
      `Standards: ${p.standards.join(", ")}\nSelling points: ${p.selling_points.join("; ")}\n\n` +
      `BUYER: ${buyer.org} (${buyer.buyer_type}, ${buyer.location})\nContact: ${buyer.contact_name || "purchasing"} ${buyer.contact_title || ""}\n` +
      `Buying signal: ${buyer.buying_signal}\nWhy it fits: ${buyer.why_fit}\nSource: ${buyer.evidence_url}\n\n` +
      `PRICE APPROACH (per ${unit}, ex-works, delivery excluded): open at ${l.list}; concede to ${l.step2}, then ${l.step3} only for real volume/commitment; ` +
      `the absolute floor is handled by a price_check tool — never mention a floor. Delivery and freight are quoted separately and settled last.`,
  });
  return { ...output, ladder: { list: l.list, step2: l.step2, step3: l.step3 }, unit, written_at: new Date().toISOString() };
}

// ---------- ElevenLabs agent (created once, reused for every call) ----------
const AGENT_PROMPT = `# Who you are
You are {{rep_name}}, an AI sales assistant calling on behalf of {{seller_company}}. You are speaking with {{contact_name}} at {{buyer_org}}.

# Your personalized call guide
{{call_brief}}

# Hard rules — never break these
1. You are an AI assistant. You said so in your first sentence. If asked, confirm it honestly.
2. PRICES: every price is per {{unit}}, ex-works / FOB origin, EXCLUDING delivery and freight. Before you say ANY price or agree to any number the buyer proposes, call price_check with that exact number. Only say numbers price_check allows. If it refuses, do not repeat the buyer's number: say it is below what you are authorized to offer and give the best authorized price it returned. Never go lower, whatever the volume, competitor quote or pressure.
3. DELIVERY is not part of this negotiation. If asked about delivered pricing, freight or shipping, say delivery is quoted separately once quantity, site and timing are confirmed, and that it is the last item to settle. Never offer free, discounted or included delivery, and never promise delivery dates.
4. Do not agree to contracts, payment terms, warranties or anything beyond the spec sheet. Your goal: confirm interest, learn quantity and timing, agree to send a formal written quote, confirm the best email.
5. If they ask not to be called again, apologize, confirm they will not be called again, and end the call.
6. Keep the call under 4 minutes. Be warm, specific and never pushy.`;

export async function ensureAgent(store, baseUrl) {
  const cached = await store.get("voice/agent.json");
  if (cached) {
    const a = JSON.parse(cached);
    if (a.base_url === baseUrl && a.version === 2) return a.agent_id;
  }
  const body = {
    name: "RFQ Scout seller agent",
    conversation_config: {
      agent: {
        first_message: "{{first_message}}",
        language: "en",
        prompt: {
          prompt: AGENT_PROMPT,
          llm: process.env.ELEVENLABS_LLM || "claude-haiku-5-5",
          tools: [
            {
              type: "webhook",
              name: "price_check",
              description: "Check a price before saying it or agreeing to it. Returns whether it is allowed and the best price you are authorized to offer.",
              response_timeout_secs: 10,
              api_schema: {
                url: `${baseUrl}/api/price-check`,
                method: "POST",
                request_headers: { "x-voice-key": process.env.VOICE_ACCESS_KEY || "" },
                request_body_schema: {
                  type: "object",
                  required: ["campaign_id", "buyer_id", "proposed_price", "buyer_committed_volume"],
                  properties: {
                    campaign_id: { type: "string", dynamic_variable: "campaign_id" },
                    buyer_id: { type: "string", dynamic_variable: "buyer_id" },
                    conversation_id: { type: "string", dynamic_variable: "system__conversation_id" },
                    proposed_price: { type: "number", description: "the exact per-unit price you want to say or the buyer proposed" },
                    buyer_committed_volume: { type: "boolean", description: "true only if the buyer stated a concrete quantity and a purchase timeline on this call" },
                  },
                },
              },
            },
            { type: "system", name: "end_call", description: "", params: { system_tool_type: "end_call" } },
          ],
        },
      },
      ...(process.env.ELEVENLABS_VOICE_ID ? { tts: { voice_id: process.env.ELEVENLABS_VOICE_ID } } : {}),
      conversation: { max_duration_seconds: 300 },
    },
  };
  const res = await fetch(`${EL}/convai/agents/create`, { method: "POST", headers: elHeaders(), body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok || !j.agent_id) throw new Error(`ElevenLabs agent create failed (${res.status}): ${JSON.stringify(j).slice(0, 400)}`);
  await store.put("voice/agent.json", JSON.stringify({ agent_id: j.agent_id, base_url: baseUrl, version: 2, created_at: new Date().toISOString() }, null, 2));
  return j.agent_id;
}

// ---------- calls ----------
export function toE164(phone) {
  const d = String(phone || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  const digits = d.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

async function onDoNotCall(store, phone) {
  const raw = (await store.get("voice/do-not-call.jsonl")) || "";
  return raw.includes(`"${phone}"`);
}

export async function placeCall({ store, campaign, buyer, script, baseUrl, live }) {
  if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_PHONE_NUMBER_ID) throw new Error("Set ELEVENLABS_API_KEY and ELEVENLABS_PHONE_NUMBER_ID");
  const liveAllowed = live && process.env.LIVE_CALLS_ENABLED === "1";
  const target = liveAllowed ? toE164(buyer.phone) : toE164(process.env.DEMO_CALL_NUMBER);
  if (!target) throw new Error(liveAllowed ? `No valid phone number for ${buyer.org}` : "Set DEMO_CALL_NUMBER (your own phone) for demo calls");
  if (liveAllowed && (await onDoNotCall(store, target))) throw new Error(`${buyer.org} asked not to be called again`);

  const agentId = await ensureAgent(store, baseUrl);
  const vars = {
    campaign_id: campaign.id,
    buyer_id: buyer.id,
    rep_name: campaign.seller.rep_name,
    seller_company: campaign.seller.company,
    contact_name: buyer.contact_name || "the purchasing team",
    buyer_org: buyer.org,
    unit: script.unit,
    call_brief: script.call_brief,
    first_message: script.first_message,
  };
  const res = await fetch(`${EL}/convai/twilio/outbound-call`, {
    method: "POST",
    headers: elHeaders(),
    body: JSON.stringify({
      agent_id: agentId,
      agent_phone_number_id: process.env.ELEVENLABS_PHONE_NUMBER_ID,
      to_number: target,
      conversation_initiation_client_data: { dynamic_variables: vars },
    }),
  });
  const j = await res.json();
  if (!res.ok || !j.success) throw new Error(`Outbound call failed (${res.status}): ${JSON.stringify(j).slice(0, 300)}`);
  const call = {
    conversation_id: j.conversation_id, call_sid: j.callSid, buyer_id: buyer.id, buyer_org: buyer.org,
    mode: liveAllowed ? "live" : "demo", dialed: liveAllowed ? target : "demo number", started_at: new Date().toISOString(), status: "initiated",
  };
  await store.put(`campaigns/${campaign.id}/calls/${j.conversation_id}.json`, JSON.stringify(call, null, 2));
  return call;
}

// Browser call (no phone provider needed): same agent, script, price_check tool and audit,
// but the conversation runs over the laptop mic/speaker with someone playing the buyer.
export async function startWebSession({ store, campaign, buyer, script, baseUrl }) {
  if (!process.env.ELEVENLABS_API_KEY) throw new Error("Set ELEVENLABS_API_KEY");
  const agentId = await ensureAgent(store, baseUrl);
  const res = await fetch(`${EL}/convai/conversation/get-signed-url?agent_id=${agentId}`, { headers: elHeaders() });
  const j = await res.json();
  if (!res.ok || !j.signed_url) throw new Error(`Could not start browser session (${res.status}): ${JSON.stringify(j).slice(0, 200)}`);
  return {
    signed_url: j.signed_url,
    dynamic_variables: {
      campaign_id: campaign.id, buyer_id: buyer.id, rep_name: campaign.seller.rep_name, seller_company: campaign.seller.company,
      contact_name: buyer.contact_name || "the purchasing team", buyer_org: buyer.org, unit: script.unit,
      call_brief: script.call_brief, first_message: script.first_message,
    },
  };
}

export async function recordWebCall({ store, campaign, buyer, conversationId }) {
  const call = { conversation_id: conversationId, buyer_id: buyer.id, buyer_org: buyer.org, mode: "browser", dialed: "browser", started_at: new Date().toISOString(), status: "in-progress" };
  await store.put(`campaigns/${campaign.id}/calls/${conversationId}.json`, JSON.stringify(call, null, 2));
  return call;
}

// ---------- after the call ----------
export async function fetchAndAudit({ store, campaign, conversationId }) {
  const res = await fetch(`${EL}/convai/conversations/${conversationId}`, { headers: elHeaders() });
  const conv = await res.json();
  if (!res.ok) throw new Error(`Could not load conversation (${res.status})`);
  const turns = (conv.transcript || []).map((t) => ({ role: t.role, message: t.message || "", tools: (t.tool_calls || []).map((c) => c.tool_name || c.name) }));
  const floor = priceLadder(campaign.pricing).floor;
  const agentText = turns.filter((t) => t.role === "agent").map((t) => t.message);
  const flags = [];
  if (agentText[0] && !/\b(AI|artificial intelligence|virtual assistant|automated assistant)\b/i.test(agentText[0])) flags.push("first message did not disclose AI");
  for (const m of agentText) {
    for (const x of m.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)) {
      const v = Number(x[1].replace(/,/g, ""));
      if (v > 0 && v < floor) flags.push(`agent said $${v}, below the floor of $${floor}`);
    }
    if (/\b(free (delivery|shipping|freight)|delivery (is )?included|including (delivery|freight)|we('ll| will) cover (delivery|freight|shipping))\b/i.test(m)) flags.push(`delivery commitment: "${m.slice(0, 120)}"`);
  }
  const optOut = turns.some((t) => t.role === "user" && /\b(don'?t call|do not call|stop calling|remove (me|us)|take (me|us) off)\b/i.test(t.message));
  const call = {
    conversation_id: conversationId,
    status: conv.status,
    duration_secs: conv.metadata?.call_duration_secs,
    summary: conv.analysis?.transcript_summary || "",
    outcome: conv.analysis?.call_successful || "",
    opt_out: optOut,
    guardrail_flags: flags,
    transcript: turns,
    audited_at: new Date().toISOString(),
  };
  const key = `campaigns/${campaign.id}/calls/${conversationId}.json`;
  const prev = JSON.parse((await store.get(key)) || "{}");
  await store.put(key, JSON.stringify({ ...prev, ...call }, null, 2));
  if (optOut && prev.mode === "live" && prev.dialed) {
    await store.append("voice/do-not-call.jsonl", JSON.stringify({ phone: prev.dialed, org: prev.buyer_org, at: new Date().toISOString() }) + "\n");
  }
  return { ...prev, ...call };
}
