import { test } from "node:test";
import assert from "node:assert/strict";
import { priceLadder, checkPrice, toE164, fetchAndAudit } from "../lib/calls.mjs";

const campaign = {
  id: "c-test",
  pricing: { quoted_price: 41.5, unit: "per linear foot" },
  product: { unit_of_sale: "per linear foot" },
};

test("ladder opens 12% above the quote and ends at the quote", () => {
  assert.deepEqual(priceLadder(campaign.pricing), { list: 46.48, step2: 44.49, step3: 42.75, floor: 41.5 });
});

test("price check refuses anything below the quoted price, whatever the commitment", () => {
  assert.equal(checkPrice(campaign, 41.49, true).allowed, false);
  assert.equal(checkPrice(campaign, 30, true).allowed, false);
  assert.equal(checkPrice(campaign, "abc", true).allowed, false);
  assert.equal(checkPrice(campaign, 41.5, true).allowed, true);
});

test("the floor is only offered once the buyer commits to volume", () => {
  assert.equal(checkPrice(campaign, 40, false).best_authorized_price, 42.75);
  assert.equal(checkPrice(campaign, 40, true).best_authorized_price, 41.5);
});

test("phone numbers normalize to E.164 or null", () => {
  assert.equal(toE164("(414) 286-2392"), "+14142862392");
  assert.equal(toE164("1-512-484-9596"), "+15124849596");
  assert.equal(toE164("+44 20 7946 0958"), "+442079460958");
  assert.equal(toE164("ext 12"), null);
});

test("post-call audit flags prices below the floor, delivery promises and a missing AI disclosure", async () => {
  const files = new Map();
  const store = {
    get: async (k) => files.get(k) ?? null,
    put: async (k, v) => void files.set(k, v),
    append: async (k, v) => void files.set(k, (files.get(k) ?? "") + v),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "done",
    metadata: { call_duration_secs: 95 },
    analysis: { transcript_summary: "test", call_successful: "success" },
    transcript: [
      { role: "agent", message: "Hi, this is Alex from Lonestar." },
      { role: "user", message: "Can you do $39 delivered?" },
      { role: "agent", message: "We can do $39.00 and free delivery." },
    ],
  }), { status: 200 });
  try {
    const call = await fetchAndAudit({ store, campaign, conversationId: "conv-1" });
    assert.ok(call.guardrail_flags.some((f) => f.includes("did not disclose AI")));
    assert.ok(call.guardrail_flags.some((f) => f.includes("$39") && f.includes("below the floor")));
    assert.ok(call.guardrail_flags.some((f) => f.startsWith("delivery commitment")));
    assert.ok(files.has("campaigns/c-test/calls/conv-1.json"));
  } finally {
    globalThis.fetch = realFetch;
  }
});
