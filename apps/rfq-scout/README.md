# RFQ Scout producer handoff

The original Scout producer source is **not included in this submission**. Inspection of the connected Scout disk found published RFQ data and runtime artifacts, with no runnable producer code or package manifest. The sole sandbox accessible in the inspected account and region contained the stock Node/Yarn environment; it was restored to its original stopped state. This does not rule out source in another account, region, computer or cofounder workspace. There is no producer install/start command to run from this directory yet.

The working dashboard and read-only bridge are in [`../outreach`](../outreach/). They can consume the existing feed when the configured Archil credentials have access. Manual RFQ creation does not depend on a running Scout producer.

The cofounder can add the original producer source here without creating a separate repository. Once it is available, document its actual dependencies, entry point, environment variables, and publishing procedure. Keep credentials, private campaigns, and runtime output out of source control.

## Published contract accepted by the dashboard

The bridge reads these paths from the disk selected by `SCOUT_DISK_ID`:

| Path | Shape |
| --- | --- |
| `rfqs/latest.json` | JSON array of entries containing `id` and `status`; only distinct entries with `status: "open"` and safe IDs are selected. |
| `rfqs/open/<id>.json` | JSON object whose `id` matches the indexed ID and whose `title` is a nonempty string. |

IDs must match `^rfq-[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$`. The adapter currently reads at most 50 indexed records per overview. It rejects oversized or malformed input and reports partial read failures; the displayed feed size is not fixed.

The following record fields are understood by the current mapper:

| Field | Type / use |
| --- | --- |
| `id`, `title` | Required identity and display title. |
| `status`, `is_open` | `"open"` and `true` confirm the record's published open-state claim. Other values generate a review warning. |
| `solicitation_number` | Optional reference string. |
| `buyer.agency` | Optional buyer display name. |
| `source_url` | Optional HTTP(S) source link, without URL credentials. |
| `summary` | Optional text summary. |
| `dates.response_due` | Optional valid `YYYY-MM-DD` bid deadline; never used as the delivery deadline. |
| `line_items` | Array. Exactly one item can prefill a product requirement; multiple or missing items require manual mapping. |
| `line_items[0].product`, `.spec` | Optional strings combined into the product description. |
| `line_items[0].quantity`, `.unit` | Quantity imports only when it is a positive integer and the explicit unit is `ea`, `each`, `unit`, `units`, `piece`, `pieces`, `pcs`, or `pc`. |
| `required_standards` | Optional array of strings used to prefill the specification. |
| `delivery.location`, `.terms` | Optional destination and shipping-term strings. |
| `found_in_run` or `found_at` | Optional revision/display reference. |
| `contact`, `submission` | Source context only; never manufacturer outreach recipients. |

The mapper deliberately leaves unsupported dimensions, grade, finish, currency, price bounds, and delivery date for operator review. It neither combines quantities across lines nor infers commercial terms. The exact implementation is in [`../outreach/server/scout.ts`](../outreach/server/scout.ts); shared response types are in [`../outreach/shared/scout.ts`](../outreach/shared/scout.ts).

## Ownership and import

Scout publishes to its own disk. The outreach backend exposes reads from that disk and writes reviewed imports only to the configured outreach disk. Import binds the selected source ID to a SHA-256 fingerprint, rejects stale revisions, and preserves source provenance in the created case. The browser does not write Scout data.

The bridge is an application-level read restriction, not a provider IAM policy. Connect credentials to disks your account is authorized to access. Adding producer source does not require moving either disk's existing data.
