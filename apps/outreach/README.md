# Source / Control

A localhost sourcing control room. Two local Codex workers synthesize English and Chinese manufacturer evidence retrieved through Keenable; two Archil microVMs verify the saved evidence before an evaluator selects suppliers. A dedicated AgentMail inbox supports reviewed RFQs, incoming quotes, one reviewed price counteroffer per supplier, and durable recovery. Simulated cases remain available for rehearsal.

## Start

Requires Node >=22.19 and Codex CLI logged in with `codex login`. Dependencies are locked in `package-lock.json`.

```sh
npm ci
npm run build
npm start
```

Open http://127.0.0.1:4310. Keep this backend running for inbox monitoring. `npm run dev` watches backend files; in a second terminal `npm run dev:web` serves the frontend at http://127.0.0.1:4311.

Set server credentials in the ignored `.env` using `.env.example` as a reference. The existing Archil setup is reused. Do not put credentials in chat, source code, case files, or browser variables. Bedrock is not used.

For Keenable, run `npm run connect:keenable`, open the returned verification URL, and approve the account link. The helper saves the key into `.env` without displaying it. Redeem the hackathon code `N1WEB` in Billing for an existing account or under “Other” during signup, according to https://artifacts.keenable.ai/archil/. Account access and credit balance are separate; this application does not purchase credits. The backend reloads `.env` on API requests.

## Real supplier email

Create an API key at https://console.agentmail.to, then run `npm run connect:email` in your own Terminal. The hidden prompt saves it into the ignored local `.env` with owner-only permissions. Set `AGENTMAIL_INBOX_ID` for an existing inbox, or choose **Connect inbox** to provision one explicitly. `EMAIL_SENDER_NAME` sets the display name for a newly provisioned inbox. No Google Cloud project or OAuth client is required. Connection and immutable local delivery-operation records stay under ignored `work/auth/`; credentials never enter Archil, the browser, or Codex worker inputs.

After research completes and required RFQ specifications and commercial fields are resolved, choose **Prepare email outreach**, select up to three suppliers, and create a separate email case. Missing required RFQ fields block outreach and negotiation; research can proceed with those fields unresolved. Its drafts show the recipient, subject, full message and published contact source. Enter missing addresses yourself. Edits must be saved and reviewed before **Approve & send email**; approval binds the exact recipient, text and revision. The original simulated case is preserved.

While the backend runs, it checks only tracked supplier threads every 15 seconds. **Check replies now** uses the same serialized polling operation. Incoming messages are saved to Archil before model processing. Grounded quote fields show their supplier-message excerpts. Conditional or incomplete offers and attachment-only quotes require clarification or manual review. Every outgoing RFQ, clarification and counteroffer requires review. After the single price counteroffer, subsequent replies update the recommendation; the app never accepts an order.

AgentMail's thread endpoint includes message bodies in its response and has no documented metadata-only option. The app polls only tracked threads, then makes individual message requests only for unseen IDs. This provider cannot offer the Gmail plan's exact metadata-only thread polling behavior.

Archil stores an immutable approval intent before the provider is contacted. The adapter sends the exact approved content directly, with a stable AgentMail idempotency key. AgentMail may append its service footer on delivery; the review screen discloses this provider behavior. It does not rely on a mutable provider draft. A lost response becomes **send unknown** and is reconciled against sent messages; unresolved operations are never blindly resent. Provider acceptance is not a guarantee of delivery to the recipient. Local operation records and the Archil journal must both be retained across restarts. This deployment supports one local backend process.

## Upload a complete RFQ

Choose **Upload RFQ** and select a searchable PDF or UTF-8 `.txt` document. Uploads are limited to 10 MB, 100 PDF pages and 400,000 extracted text characters, with at most 50 extracted product lines; split larger requests. The original bytes and fingerprint are persisted to the outreach Archil disk before text extraction and Codex processing. In explicit `APP_STORAGE=file` test mode, the same records use local test storage.

Review the extracted product lines, source-page quotations, document requirements and uncertainties. Every non-null extracted buying field must have supporting source text; unsupported specifications, quantities and price limits remain `null`. Historical awards are not treated as buying limits, and the bid closing date is separate from the delivery requirement. Select the lines you want to source: each selected line creates its own case. You can save those cases or request research immediately, using the known requirements. Real email remains blocked until required specifications and commercial fields are complete, and every send still requires approval.

The original document remains available for download from the review. Scanned PDFs need OCR or a searchable replacement; OCR is not built in. Password-protected PDFs must be unlocked. A document with readable and scanned pages may yield partial evidence, so review the unreadable-page warnings. Failed extraction preserves the uploaded source and reports an error instead of inventing fields.

## Demo

For your own RFQ, upload the complete document as described above or choose **New RFQ** to enter one product manually. **Save draft** persists a case without running research. JSON import remains available as an advanced input. Each case represents one product line; a multi-line upload creates separate cases for selected lines. Missing values stay unresolved and research uses only known requirements. Both discovery tracks use that case's RFQ; fastener-specific terminology is only added for fastener requests.

Live sourcing requires a connected Keenable account with available credits. A missing connection blocks the start request with an actionable error while keeping the RFQ saved. After `npm run connect:keenable` succeeds, the running backend detects the new local key and the dashboard updates its connection status; no key is sent to the browser.

1. Load the default RFQ: 50,000 ISO 4762 M8x30 Grade 12.9 socket-head cap screws, black oxide, CIF Oakland. USD target .065, maximum .082 are fictional demo inputs. Delivery deadline is explicitly unresolved.
2. Start sourcing. Keenable performs real search and live fetches; wait for the sourced shortlist. A run may select fewer than three suppliers when evidence is insufficient. No synthetic manufacturers are substituted.
3. Open Demo controls and simulate concurrent initial quotes. The three actual Codex process slots show model activity; with three suppliers and idle slots the three negotiations run concurrently.
4. Inject the duplicate, Grade 8.8 substitution, and final .064 reply. Expect deduplication, `needs attention`, and `target met` respectively. Terms must match before the final price qualifies.
5. To demonstrate recovery, enable **Hold queue 5s** before submitting a new reply. Wait for **Persisted to Archil WAL — Pending Processing**, stop the backend with Ctrl+C, then run `npm start`. It resumes pending messages from Archil.

After a successful live research run, **Replay saved evidence** in the Evidence view creates a new case using its historical snapshots. Start that case to run Codex synthesis, Archil verification, and supplier evaluation again without another Keenable search. Original retrieval times and truncation flags remain visible. No saved research is bundled or represented as live research; account connection is required to capture the first real supplier run.

In simulated cases, inbox messages, quotes, and commercial prices are explicitly simulated and cannot send real email. Real-email cases use the reviewed workflow above. Counteroffer commercial text is rendered deterministically from RFQ terms. Every supplier gets at most one price counteroffer. A target-met result is a recommendation, not purchase acceptance. Neither mode places orders or makes payments.

## Persistence and concurrency

All application records use the isolated `autonomous-sourcing/v1/` prefix on the configured disk. Existing unrelated files are never touched. Each case and research attempt has a unique path. Source snapshots and decisions are immutable by application convention; SHA-256 identifies the saved bytes, not the truth of a website's claims.

The orchestrator persists incoming messages before HTTP 202, saves complete decisions before projections, and replays missing projections after crashes. Deterministic outbox IDs deduplicate simulated deliveries. Model inference can repeat if a crash precedes saving the decision. A single local backend owns case updates; per-case commit locks and per-supplier message queues do not coordinate multiple servers. The three-slot priority queue does not preempt active model processes.

The verifier uses `archil.exec` with read-only scripts/input mounts and conditional output mounts. It validates contacts and quoted evidence, fingerprints snapshots, and conservatively merges identities. Keenable's raw snapshot is authoritative for grounding; independently fetched prompted extraction is advisory and may differ from that snapshot. Truncated or missing evidence remains unresolved.

## APIs

- `GET /api/runtime`, `GET /api/events` (SSE), `GET /api/health`
- `GET /api/rfq-uploads` lists saved uploads; `GET /api/rfq-uploads/:id` returns extraction status, lines and evidence
- `POST /api/rfq-uploads` accepts the raw PDF/TXT body with `Content-Type: application/pdf` or `text/plain` and a URI-encoded filename in `X-File-Name`; returns `202` after persistence, with extraction queued
- `GET /api/rfq-uploads/:id/document` downloads the original upload
- `POST /api/rfq-uploads/:id/import` accepts `{ "lineIds": ["line-1"], "start": false }`; creates selected cases, optionally requests research, and returns any start errors alongside the saved cases
- `GET/POST /api/cases`; creation accepts `{ "rfq": ... }` or the default fixture
- `GET /api/cases/:id`; `POST /api/cases/:id/run`
- `POST /api/cases/:id/replay` creates a new case from the completed case's saved evidence
- `POST /api/cases/:id/inbox/reply` with `messageId`, `supplierId`, `text`
- `POST /api/cases/:id/hold` with `holdProcessingMs` (`0` or `5000`)
- `POST /api/cases/:id/read` with `supplierId`
- `POST /api/cases/:id/demo` with `action`: `initial-quotes`, `duplicate`, `spec-mutation`, or `final-reply`
- `GET /api/email/status`; `POST /api/email/connect`; `POST /api/email/sync`
- `POST /api/cases/:id/email-outreach` with `supplierIds` (one to three)
- `PATCH /api/cases/:id/email-drafts/:draftId` with `revision`, `to`, `subject`, `body`
- `POST /api/cases/:id/email-drafts/:draftId/approve-send` with `revision`, `contentHash`

RFQ fields: `description`, `standard`, `size`, `grade`, `finish`, `quantity`, `currency`, `incoterm`, `destination`, `targetUnitPrice`, `maxUnitPrice`, and `requiredBy` (ISO date or null). The description is required; other unknown fields are represented explicitly as `null`, not omitted or guessed. Research accepts incomplete requirements, while real outreach requires the specifications and commercial fields. A missing delivery date remains a separate unresolved requirement. See `shared/types.ts` and `shared/rfq-upload.ts` for contracts.

## Validation

```sh
npm run typecheck
npm test
npm run build
```

Tests exercise concurrency and priority, strict output schemas, fake contacts, false entity merges, Keenable request contracts, duplicate/conflicting replies, four partial-write crash boundaries, and unread-message races. Test fixtures are synthetic and never presented as real research. `APP_STORAGE=file` selects an explicit local test adapter; the app never silently falls back when Archil fails.

Email tests additionally cover exact-content approval, provider idempotency and reconciliation, duplicate replies, one-counteroffer policy, quote provenance, and crashes around delivery. They use a fake email transport and never contact suppliers. A real acceptance rehearsal requires an operator-controlled recipient: review/send an RFQ, reply with a complete quote, review/send the counteroffer, and reply with final terms. Do not treat mocked acceptance checks as proof of a completed real exchange.

## Unified RFQ Scout workflow

The local dashboard now reads the separate `rfq-scout` Archil disk and presents its published requests beside a clearly fictional fastener RFQ sample. Keep the disks separate: Scout owns discovery records, and `out-reach` owns reviewed sourcing cases, supplier evidence, drafts, decisions and recovery. The backend is the bridge; disks do not exchange messages by themselves. Configure credentials authorized for your disks; the Scout adapter exposes only reads. This application-level restriction is not a separate provider IAM policy.

- `GET /api/scout` reads a bounded current feed and includes the fictional sample. Refresh Scout explicitly to read new published results.
- `GET /api/scout/items/:id` reloads an individual current source and its fingerprint.
- `GET /api/scout/items/document-demo-fasteners/document` serves the fictional sample JSON locally.
- `POST /api/scout/import` accepts `{source:{id,sha256},rfq}` after operator review. It verifies that the source revision still matches, validates/canonicalizes the complete RFQ, preserves the source record, and creates a deterministic case on `out-reach`. Identical retries reuse that case; a changed source or reviewed RFQ creates a new case.

Scout import does not launch research or send mail. The dashboard’s **Save & start sourcing** action starts the existing live pipeline after successful import. Existing email approvals remain mandatory. Published buyer contacts are never treated as supplier email addresses. Scout records with multiple products require choosing one product; document uploads provide a separate line-selection flow that creates one case per selected product. Non-piece quantities and unsupported specifications remain unresolved.

The bundled sample describes 50,000 ISO 4762 M8x30 Grade 12.9 black-oxide screws, CIF Oakland. Its USD 0.065 target and USD 0.082 maximum are fictional demonstration values; the delivery deadline is unresolved. Real buyer documents, their extracted contents, private campaigns and inbox data are not included in the repository. Enter verified requirements for real sourcing. The current discovery pipeline targets Chinese manufacturers and does not determine procurement eligibility or submit government bids.

Source provenance follows evidence replays and fresh email cases. The source fingerprint identifies the original JSON bytes; `snapshotSha256` separately identifies the preserved raw snapshot record. No Scout records are modified or migrated. Set `SCOUT_DISK_ID` server-side to change the input disk.

The calm industrial visual direction and workflow principles are recorded in `.impeccable.md`. The dashboard keeps RFQ Scout, sourcing, evidence and inbox in one shell; agent execution details and simulated demo controls are available on demand.
