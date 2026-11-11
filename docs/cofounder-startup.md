# Start the shared project

Either founder can run the same code from this repository. The repository shares code; the two Archil disks share persistent data. Neither creates a running website by itself.

Choose one backend owner for the shared outreach disk and `ARCHIL_PREFIX`. **Do not run two backend processes against that same disk and prefix.** The app's queues and update locks belong to one process; Archil's shared storage does not turn them into distributed locks. The setup check cannot detect another founder's running backend.

## Start on the chosen host

Use Node.js 22.19 or newer. Install Codex CLI using the [official instructions](https://developers.openai.com/codex/cli), and authenticate on the machine that will run the backend. `codex login status` checks whether credentials are present; it does not prove model quota or a successful model request. See the [official login reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-login).

```sh
git clone https://github.com/JHJORE/hackathon_archil.git
cd hackathon_archil
npm run setup
cp -n apps/outreach/.env.example apps/outreach/.env
codex login
```

If the repository is already checked out, use that checkout and preserve its local environment file. `npm run setup` installs the app dependencies, including the development dependencies needed by `npm start`; it does not install or authenticate Codex.

Edit the ignored `apps/outreach/.env` on the chosen host:

| Setting | Purpose |
| --- | --- |
| `ARCHIL_API_KEY` | Server credential authorized to access the configured disks. |
| `ARCHIL_REGION` | Region containing those disks. |
| `ARCHIL_DISK_ID` | Outreach disk: reviewed RFQs, research, negotiations and recovery. |
| `ARCHIL_PREFIX` | Outreach application namespace. Use the existing prefix when continuing the same deployment. |
| `SCOUT_DISK_ID` | Separate Scout disk: published RFQs consumed read-only. Optional for manual RFQs. |
| `KEENABLE_API_KEY` | Required for new live supplier searches; account credits are also required. |
| `AGENTMAIL_API_KEY` | Optional until real, reviewed email outreach is used. |
| `AGENTMAIL_INBOX_ID` | Existing dedicated inbox, if configured; otherwise connect an inbox explicitly in the dashboard. |

The repository grants no disk or service access. Configure credentials locally; neither environment files nor Codex authentication belong in Git. `npm run connect:keenable` can link Keenable, and `npm run connect:email` can save an AgentMail key through a hidden terminal prompt.

```sh
npm run build
npm run check:setup
npm start
```

Open [http://127.0.0.1:4310](http://127.0.0.1:4310) **on that host**. Keep the backend running for inbox polling. The setup check prints configuration names and presence only, discards Codex status output, and makes no Archil, Keenable or AgentMail requests. A successful check does not validate API permissions, disk contents, credit balance or model inference. Missing optional Scout or email configuration is reported separately.

For a separate local test, `APP_STORAGE=file` stores cases under ignored `apps/outreach/work/local-test-store`. This is not shared team storage, and live verification still needs Archil. It does not simulate a successful service connection.

## Bring an RFQ into the app

Choose **Upload RFQ** for a complete searchable PDF or UTF-8 `.txt` file, up to 10 MB, 100 PDF pages and 400,000 text characters. The host saves the original to the outreach disk before extraction. Review the extracted fields against their source quotations, then select product lines to create separate sourcing cases. Extraction uses the host's Codex login; starting new supplier research additionally requires Keenable.

Unknown values remain `null`. Research can begin with known requirements, while required missing specifications or commercial terms block real email. Uploading or importing a document never approves an email. Scanned PDFs require OCR before upload; the app has no built-in OCR. The Scout producer is not required for this upload workflow. See [the app guide](../apps/outreach/README.md#upload-a-complete-rfq) for details.

## Let both founders use one running app

At present the application binds to localhost and accepts local request origins. The Mac-local address is not a remote-access link for the cofounder. No shared deployment or exposed Archil dashboard has been established by adding this repository.

When private hosting is configured, both founders should open **one running backend's authenticated URL**. Hosting requires an explicit choice of host and access control, updates to the localhost request guard, and model/service credentials on that host. Do not expose the existing local app directly as a public, unauthenticated email control panel.

Archil can host network services in a [persistent sandbox](https://docs.archil.com/compute/sandboxes/introduction#hosting-network-services). Its one-shot [`disk.exec` commands stop after five minutes](https://docs.archil.com/compute/serverless-execution#limits). Sandbox sessions pause at their configured limit; the documented Free-plan limit is 30 minutes, and a paused backend cannot poll email. The Free-plan [egress allowlist](https://docs.archil.com/compute/sandboxes/firewall#free-plan-allowlist) also needs checking against Keenable, AgentMail and the chosen model authentication. Account entitlements and hosting configuration remain a separate architecture decision.

To transfer ownership of an existing deployment, stop the old backend and wait for shutdown before starting the new one. Retain its Archil namespace and private local delivery-operation records in `apps/outreach/work/auth/`; those records are not included in the repository. Configure the new host's credentials locally. Running a fresh clone while the old backend still owns the same cases is not a supported handoff.

## Where is the Scout producer?

The dashboard includes the Scout read adapter, not the cofounder's original producer code. The inspected Scout disk contained published RFQs and runtime artifacts. The sole sandbox accessible in that inspected account and region contained the stock Node/Yarn environment and was restored to its original stopped state after inspection. Those checks do not establish what exists in another account, region, computer or cofounder workspace.

Put the original producer source in [`apps/rfq-scout`](../apps/rfq-scout/) when its actual workspace or export is supplied. Keep the existing disk records in place. That directory documents the published JSON contract, so source integration can happen in this same repository without merging the disks or inventing a replacement producer.
