# CRM connector

The finance system runs on **Projects**: a won job or order for one customer with a contract value, a payment schedule, receipts, invoices, supplier purchase orders and milestone dates. Projects come from your CRM through a connector, or you keep them in this app by hand. The app only ever reads its own store; the connector's job is to fill it (`lib/crm/connectors.ts`, `lib/crm/mapping.ts`, `lib/crm/types.ts`).

Pick the mode in Setup ▸ CRM (`crm.mode`, or `CRM_MODE`):

| Mode | How projects arrive | When to use |
|---|---|---|
| `manual` (default) | Created and edited in the app (Finance ▸ Projects, `POST /api/finance/projects`) | No CRM, or a CRM with no API |
| `rest` | The app GETs a JSON endpoint on a schedule (every 30 minutes, or `POST /api/finance/crm-sync`) | Any CRM with a read API |
| `webhook` | The CRM POSTs project upserts to `/api/webhooks/crm` | A CRM that can call out on change |
| `mcp` | The app calls a tool on your CRM's MCP server that returns projects | A CRM that already has an MCP server |
| `none` | Nothing is pulled; projects stay as they are | Pausing a connector |

Whatever the mode, anything this app records itself (payments, invoices, extra costs, order-finance overrides, QuickBooks mapping, supplier acknowledgements) lives in a separate **finance overlay** (`PROJECT_FINANCE#<id>`), so a CRM re-sync never loses it. Reads always return the merged view.

## The Project JSON contract

This is the shape the app stores and the shape every connector produces (`lib/crm/types.ts`). Only `firstName` or `lastName` is required; everything else is optional. Dates are ISO `YYYY-MM-DD`; `"N/A"` is read as null.

```jsonc
{
  "id": "P-123",                       // your CRM's id; generated if missing
  "firstName": "Jane", "lastName": "Doe",
  "email": "jane@example.com", "phone": "+44…", "postcode": "AB1 2CD", "address": "1 High Street",
  "designer": "sam@example.com",       // salesperson / account owner (commission)
  "status": "active",                  // active | completed | cancelled | lost
  "opsStage": "Survey",                // free text from the CRM
  "wonDate": "2026-03-01",
  "wonValue": 25000,                   // NET order value ex VAT, EXCLUDING installation
  "orderFinance": {                    // optional overrides of the money model
    "vatRate": 20,
    "schedule": { "deposit": { "pct": 40, "amount": null, "overridden": true, "dueDate": null, "invoiceId": null, "note": "" } },
    "installation": { "value": 6000, "vatRate": 20, "retentionApplies": true },
    "updatedAt": "2026-03-01T10:00:00Z", "updatedBy": "crm"
  },
  "payments": [ { "id": "pay-1", "amount": 10500, "date": "2026-03-02", "method": "Bank Transfer", "scheduleKey": "deposit",
                  "confirmation": { "source": "bank_statement", "by": "owner", "at": "2026-03-03T09:00:00Z", "ref": null } } ],
  "invoices": [ { "id": "inv-1", "number": "SI-2026-0001", "date": "2026-03-01", "dueDate": "2026-03-08",
                  "items": [ { "description": "Deposit", "qty": 1, "unitPrice": 8750 } ], "vatRate": 20, "status": "sent",
                  "scheduleKey": "deposit", "sentAt": null, "paidAt": null, "paymentLink": null } ],
  "extraCosts": [ { "id": "x-1", "amount": 300, "date": "2026-05-01", "category": "Remedial", "description": "Replacement door", "addedBy": "ops", "addedAt": "…" } ],
  "supplierOrders": [ {
    "id": "po-1", "reference": "PO-1001", "supplierName": "Acme Worktops", "supplierId": null,
    "status": "sent",                  // draft | pending_signoff | signed_off | sent | acknowledged | discrepancy | confirmed | cancelled
    "orderType": "contract",           // contract | addon | remedial
    "lines": [ { "code": "WT-1", "description": "Quartz 3m", "qty": 1, "unitCost": 1200, "unitSell": 2100, "catalog": "worktops" } ],
    "orderedNet": null,                // overrides Σ qty × unitCost when the CRM gives a total
    "ack": null, "sentAt": "2026-03-05", "createdAt": "2026-03-05T12:00:00Z", "notes": null
  } ],
  "costing": { "sales": { "revenue": 25000, "totalCost": 15000, "profit": 10000, "marginPct": 40, "capturedAt": "…" }, "order": null },
  "surveyOrderAt": "2026-03-20", "deliveryDate": "2026-05-10", "installStart": "2026-05-12", "installEnd": "2026-05-16",
  "signOff1At": null, "signOff2At": null, "stage1Date": null, "stage2Date": null,
  "supplyOnly": false, "completedAt": null, "closedAt": null,
  "qbo": { "customerId": "42", "classId": "7", "className": "Doe, Jane" },
  "notes": "…",
  "source": { "kind": "rest", "externalId": "P-123", "syncedAt": "…" },   // set by the connector
  "createdAt": "…", "updatedAt": "…"
}
```

Schedule keys: `deposit`, `survey_payment`, `delivery_balance`, `install_deposit`, `install_day1`, `install_stage1`, `retention`. Payment methods: Bank Transfer, Card, Cash, Finance, Other. Confirmation sources: `bank_statement`, `owner`, `finance_provider`, `card_terminal`, `agent`. Extra cost categories: Labour, Materials, Remedial, Delivery, Other. Invoice status: draft, sent, paid, void.

Acknowledgement objects (`supplierOrders[].ack`) carry `receivedAt`, `lines[]`, `discrepancies[]` (`qty`, `unitCost`, `missing_from_ack`, `extra_in_ack`, `extra_charge`, `total`), `status` match / discrepancy, `supplierRef`, `expectedDate`, `extras`, totals and the mailbox / message that carried it. Acks found by the orders job go into the overlay, so a CRM that knows nothing about acknowledgements is fine.

## Field mapping

Common field names are recognised without any mapping (`normaliseIncomingProject` in `lib/crm/mapping.ts`). If your payload uses other names, give a mapping in Setup ▸ CRM (`crm.rest.mapping`): `{ "ourField": "json.path" }`. Paths are dotted with optional indexes: `data.customer.name`, `orders[0].ref`. A mapped field wins over the built-in fallbacks.

| Our field | Built-in fallbacks (first non-empty wins) |
|---|---|
| `id` | id, _id, projectId, leadId, dealId, reference |
| `name` (split into first / last when neither is given) | name, customer, customerName, client, clientName, title |
| `firstName` / `lastName` | firstName, first_name, contact.firstName / lastName, last_name, surname, contact.lastName |
| `email`, `phone` | email, contact.email, customerEmail / phone, contact.phone, mobile |
| `postcode`, `address` | postcode, postCode, zip, address.postcode, address.zip / address, address.line1, siteAddress |
| `designer` | designer, owner, assignedTo, salesperson, accountOwner, owner.email |
| `status` | financeStatus, status, stage, opsStage, pipelineStage (text matched: *cancel* → cancelled; *lost*, *dead*, *closed lost* → lost; *complete*, *done*, *signed off*, *finished*, *delivered* → completed; else active) |
| `opsStage` | opsStage, stage, pipelineStage, status |
| `wonDate` | wonDate, closedAt, closeDate, orderDate, signedAt |
| `wonValue` | wonValue, value, netValue, orderValue, amount, dealValue (currency symbols stripped) |
| `salesRevenue`, `salesCost`, `orderRevenue`, `orderCost` | costing.sales.revenue / totalCost, costing.order.revenue / totalCost, or the flat names; builds `costing` |
| `orderFinance`, `payments`, `invoices`, `qbo` | orderFinance / payments, receipts / invoices / qbo, quickbooks (taken as-is) |
| `supplierOrders` | supplierOrders, orders, purchaseOrders (each order: id; reference, poNumber, po, number; supplierName, supplier.name, supplier, vendor; supplierId; status; orderType, type; lines with code / sku, description / name, qty / quantity, unitCost / cost / price, unitSell / sell, catalog / catalogue; orderedNet, net, total, value; ack; sentAt; createdAt; notes) |
| `surveyOrderAt`, `deliveryDate`, `installStart`, `installEnd` | surveyOrderAt, surveySignedAt / deliveryDate, delivery / installStart, installationStart, installDate / installEnd, installationEnd |
| `signOff1At`, `signOff2At` | signOff1At, stage1SignOff, practicalCompletionAt / signOff2At, stage2SignOff, finalSignOffAt, completedAt |
| `supplyOnly`, `notes` | supplyOnly / notes, description |

Example mapping for a CRM whose deals look like `{ deal_id, contact: { full_name, email }, site: { post_code }, value_net, closed_on, pipeline_stage, pos: [...] }`:

```json
{ "id": "deal_id", "name": "contact.full_name", "email": "contact.email", "postcode": "site.post_code",
  "wonValue": "value_net", "wonDate": "closed_on", "status": "pipeline_stage", "supplierOrders": "pos" }
```

## REST pull

Setup ▸ CRM ▸ REST, or env `CRM_REST_PROJECTS_URL` + `CRM_REST_TOKEN`:

- `projectsUrl` (required): GET returns JSON. The list is found at `rootPath` (a JSON path), or at the top level if the body is an array, or under `projects`, `data` or `items`.
- `bearerToken` → `Authorization: Bearer …`; `headers` → any extra headers (API keys, tenant ids).
- `projectUrl` (optional, `{id}` placeholder): reserved for single-project reads.
- `noteUrl` (optional, `{id}` placeholder): write-back, see below.
- Sync runs every 30 minutes (`/api/cron?job=crm-sync`), from the wizard's "Test" button, or `POST /api/finance/crm-sync`. The result (`fetched`, `upserted`, `errors`, `ms`) is stored as the CRM health row and shown by `whoami` and `/api/finance/status`.
- Requests time out after 30 seconds; a 5xx is retryable, a 4xx is not.

Only send won / active jobs and the ones that changed status recently; the app marks nothing as cancelled on its own. Deleting on the CRM side is handled through the webhook (below) or by sending `status: "cancelled"`.

## Webhook push

Setup ▸ CRM ▸ Webhook sets a shared secret (`crm.webhook.secret` / `CRM_WEBHOOK_SECRET`). Your CRM POSTs to `https://<your app>/api/webhooks/crm` with either

- `X-Signature: sha256=<hex HMAC-SHA256 of the raw body under the secret>` (also accepted as `X-Hub-Signature-256`), or
- `Authorization: Bearer <secret>`.

The body is one project, an array of projects, or `{ "projects": [ … ] }`; each item goes through the same mapping as REST. Send `{ "id": "P-123", "deleted": true }` to cancel a project.

```bash
BODY='{"id":"P-123","firstName":"Jane","lastName":"Doe","email":"jane@example.com","wonValue":25000,"wonDate":"2026-03-01","status":"won"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$CRM_WEBHOOK_SECRET" | sed 's/^.* //')
curl -sS -X POST https://finance.example.com/api/webhooks/crm \
  -H "Content-Type: application/json" -H "X-Signature: sha256=$SIG" \
  --data "$BODY"
# → {"ok":true,"results":[{"id":"P-123","action":"upserted"}]}
```

A bad signature returns 401 `WEBHOOK_SIGNATURE_INVALID`; no secret configured returns 503.

## MCP tool contract

Setup ▸ CRM ▸ MCP, or env `CRM_MCP_URL` + `CRM_MCP_TOKEN`. The app connects as an MCP client (Streamable HTTP, `Authorization: Bearer <token>`), lists the server's tools, and on each sync calls:

- `listTool` (default `list_projects`) with `listArgs` (default `{}`). The result may be `structuredContent` or a JSON text block; the list is found at `rootPath`, or at the top level, or under `projects`, `leads`, `data` or `items`. Each item is mapped like a REST payload (`crm.rest.mapping` applies).
- `noteTool` (optional): called for write-back with `{ projectId, leadId, text, note, by }` so most naming conventions work unchanged.
- `getTool` (optional): reserved for single-project reads.

The wizard's test calls `tools/list` and reports whether `listTool` exists, then fetches a sample.

## OAuth2 for REST CRMs (optional)

Setup ▸ CRM ▸ OAuth2 (`crm.oauth2`): `enabled`, `authorizeUrl`, `tokenUrl`, `clientId`, `clientSecret`, `scopes`, `grant`.

- `client_credentials`: the app fetches a token from `tokenUrl` on demand and caches it in the store (`TOKEN#CRM`) until a minute before expiry. Fully unattended.
- `authorization_code`: the owner clicks "Connect CRM" in the wizard (`/api/oauth/crm/connect`), consents at the CRM, and the callback (`/api/oauth/crm/callback`, redirect URI `<APP_URL>/api/oauth/crm/callback`) stores the tokens. Refresh tokens are used thereafter; if there is no refresh token the sync fails with 428 `CRM_OAUTH_CONSENT_REQUIRED` until someone reconnects.

When OAuth2 is enabled it replaces the static bearer token on REST calls and write-back.

## Manual mode

With no connector, projects are created in Finance ▸ Projects or by `POST /api/finance/projects` (same JSON as above, `lastName` required) and edited in place, including supplier orders. Everything else works identically; `source.kind` is `manual`.

## Write-back

Best effort and notes only. When an agent calls `add_project_note`, the note is stored here and, if configured, forwarded: REST → `POST noteUrl` (with `{id}` replaced) and body `{ projectId, text, by, source: "finance-agents" }`, with the bearer / OAuth2 token and extra headers; MCP → `noteTool`. Failures are swallowed so an agent run never fails because the CRM was down. Nothing else is ever written to the CRM: receipts, invoices and mappings live in this app's overlay.
