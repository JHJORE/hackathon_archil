# Voice buyer finder

The sell side of Source / Control. Upload a product spec sheet, let an agent swarm find **private companies** likely to buy it, then run hyper-personalized sales calls with an ElevenLabs voice agent. Price guardrails are enforced in code, not only in the prompt.

This app is self-contained. It does not import from, or write to, `apps/outreach` or `apps/rfq-scout`, and it uses its own environment variable names, so it cannot touch the outreach or scout disks.

## Flow

1. **Spec in.** Upload a PDF (or paste text) and enter the **quoted price**. Claude reads the PDF and builds a product profile.
2. **Buyer swarm** (3 agents with Keenable search, in parallel):
   - `agent-contractors`: contractors bidding on or building projects that need the product
   - `agent-industrial`: plants, manufacturers and OEMs that use it
   - `agent-private-util`: investor-owned utilities, EPC firms and developers

   Government buyers are rejected in code. The top 10 are ranked by fit and whether a phone number was found.
3. **Personalized script** per buyer: AI-disclosure opener, hooks from the buyer's real project, discovery questions, objection handling, price approach, close (a formal written quote).
4. **Call**, two ways:
   - **Talk in browser**: the agent talks through the laptop mic and speaker while someone plays the buyer. Needs no phone provider.
   - **Phone call**: ElevenLabs + an imported Twilio number. Demo mode rings `DEMO_CALL_NUMBER`.
5. **Audit.** After each call the transcript is checked and flags are shown on the buyer card.

## Guardrails

| Rule | Where it's enforced |
|---|---|
| Never below the quoted price | The voice agent must call `POST /api/price-check` before saying any number; anything below the floor is refused. The floor is only offered once the buyer commits to volume. |
| Delivery excluded, settled last | Every price is ex-works / FOB origin. The prompt forbids free or included delivery, and the audit flags delivery promises. |
| AI disclosure | The opening line says it's an AI assistant; the audit flags a missing disclosure. |
| Human approval | Every call needs an approval click. Ringing a real buyer needs the "live" box **and** `LIVE_CALLS_ENABLED=1`. |
| Opt-out | "Don't call us" puts the number on `voice/do-not-call.jsonl`; live calls check it first. |
| No webhook, no call | Calls are blocked until `PUBLIC_BASE_URL` is a public https URL that ElevenLabs can reach. |

Check US rules (TCPA, state AI-disclosure and call-recording consent laws) before enabling live calls.

## Run

```sh
cd apps/voice
npm install
cp .env.example .env     # fill in the keys
npm test                 # guardrail tests
npm start                # http://localhost:4320
```

For ElevenLabs to reach the price check from your laptop, expose the server and set `PUBLIC_BASE_URL`:

```sh
cloudflared tunnel --url http://localhost:4320
```

The ElevenLabs key needs **ElevenAgents write access** (`convai_write`): the app creates one agent on first use and reuses it.

## Files

```text
server.mjs           local server: public/index.html + /api/<name> -> api/<name>.mjs
api/campaigns.mjs    POST spec -> product profile -> buyer swarm (streams progress); GET campaigns
api/call.mjs         write script, start browser session, place phone call, fetch + audit transcript
api/price-check.mjs  webhook the voice agent must call before quoting
lib/product.mjs      spec PDF -> product profile (Claude)
lib/buyers.mjs       private-company buyer swarm (AI SDK ToolLoopAgent + Keenable)
lib/calls.mjs        price ladder, scripts, ElevenLabs agent, calls, audit
lib/store.mjs        ./data by default; optional dedicated Archil disk (VOICE_ARCHIL_DISK_ID)
tests/               guardrail tests
```
