# Source / Control

**From an RFQ to sourced suppliers and reviewed negotiations.**

One local procurement dashboard combines RFQ Scout, parallel manufacturer research, source evidence, and a supplier inbox. Archil stores the work and runs verification beside the saved evidence. The operator completes buying requirements and approves every real outgoing email.

![RFQ Scout with fictional sample data; integrations disabled for this screenshot](docs/dashboard.png)

*Public example only. Your own credentials and disks enable live research and inbox monitoring.*

## What runs

- **Research:** Keenable search and live fetches feed English and Mandarin Codex workers in parallel.
- **Verification:** parallel Archil executions check contacts, fingerprint snapshots, and prepare grounded supplier candidates.
- **Negotiation:** three shared worker slots process supplier replies, with one reviewed price counteroffer per supplier.
- **Recovery:** durable receipts and decisions survive restarts; duplicate messages and uncertain sends are reconciled.
- **One desk, two disks:** Scout records are read-only inputs; reviewed cases, evidence, and negotiations belong to the outreach disk.

```text
apps/outreach/        Unified dashboard, orchestrator, integrations, tests
apps/rfq-scout/       Producer handoff; original source not yet included
apps/voice/           Sell side: spec upload -> private-buyer swarm -> ElevenLabs calls (see apps/voice/README.md)
docs/architecture.md
```

> **Scout producer source is not included yet.** The unified app already reads published Scout records from a separate Archil disk; its read adapter is not the producer that discovers and publishes RFQs. Add the cofounder’s original source under [apps/rfq-scout](apps/rfq-scout/) in this repository when available. Manual RFQ entry and the fictional sample review work independently. Feed contents depend on the configured disk, records, and access permissions.

## Run locally

Requires **Node.js ≥22.19**, an installed **Codex CLI authenticated with `codex login`**, Archil access, and Keenable access/credits for live research. AgentMail is optional. Models run through your local Codex authentication; this version uses neither Bedrock nor a separate model API key.

From the repository root:

```sh
npm run setup
cp apps/outreach/.env.example apps/outreach/.env
# Configure the local environment file.
npm run build
npm start
```

Open [localhost:4310](http://127.0.0.1:4310). Root scripts delegate to `apps/outreach`; setup does not install Codex CLI. For development, run `npm run dev` and `npm run dev:web` in separate terminals. The Vite UI uses port `4311`.

See [.env.example](apps/outreach/.env.example). Set `ARCHIL_API_KEY`, `ARCHIL_REGION`, and an `ARCHIL_DISK_ID` your account can access. `ARCHIL_PREFIX` isolates outreach records. `SCOUT_DISK_ID` selects the separate published-input disk. The repository does not grant access to the team's disks.

```sh
npm run connect:keenable
# Optional, for real email:
npm run connect:email
```

These helpers save keys locally without displaying them. Keenable linking and available credits are separate prerequisites. For AgentMail, obtain a key from its [console](https://console.agentmail.to); select **Connect inbox** to provision a dedicated inbox, or configure an existing `AGENTMAIL_INBOX_ID`. Keep credentials in the ignored environment file.

## Use it

1. **Review an RFQ** from Scout or the fictional sample, or choose **New RFQ**. Complete missing specifications, quantity, shipping terms, and price limits. Each case represents one product line.
2. **Start sourcing.** Inspect the returned evidence and uncertainties. A run can return fewer than three suppliers when evidence is insufficient; no manufacturers are invented to fill the shortlist.
3. **Choose communications.** Demo controls inject explicitly simulated quotes. **Prepare email outreach** creates a separate real-email case with editable drafts. Buyer contacts from Scout are never treated as supplier addresses.
4. **Review each send.** Save changes, then approve the exact recipient and saved message. Replies can generate a clarification or one counteroffer, each requiring approval. A target-met result is a recommendation, not an accepted purchase.

The backend monitors tracked email threads while running. Unknown sends are reconciled instead of blindly resent. Retain both Archil state and local delivery-operation records across restarts. This app does not place orders or make payments.

## Rehearse a 90-second demo

First connect the services and capture a real research run. For three concurrent negotiations, prepare a case with three sourced suppliers and idle worker slots.

1. Show an RFQ's source fingerprint and the prepared supplier shortlist.
2. Open **Demo**, enable **Hold queue 5s**, and inject initial quotes. Show the durable pending receipt; stop and restart the backend during the hold window.
3. Expand **Agent activity** to show resumed work and concurrent negotiations.
4. Inject a duplicate and the Grade 8.8 substitution: expect deduplication and `needs attention`.
5. Inject the final `$0.064` reply: matching terms can reach `target met`; unresolved delivery requirements remain visible.

Fastener prices and replies in this sequence are fictional; no external email is sent. Ninety seconds is a presentation target, not a latency guarantee. **Replay saved evidence** reuses a prior run's snapshots with original timestamps while synthesis and Archil verification run again. Saved research is not bundled or represented as fresh search.

## Validate and inspect

```sh
npm run typecheck
npm test
npm run build
```

The clean submission copy passes dependency installation, TypeScript checking, **105 tests**, and a production build.

Tests use synthetic fixtures and fake email transport for scheduling, grounding, source revisions, approval, deduplication, and recovery. They do not prove that a real supplier exchange occurred.

Read [the architecture](docs/architecture.md) for data flow and boundaries, [the app README](apps/outreach/README.md) for operating details, and [shared contracts](apps/outreach/shared/) for integration types.
