# Architecture

A single Next.js 14 (App Router) application that holds the finance store, talks to QuickBooks, your mailboxes and your CRM, serves a web UI for the owner, serves an MCP server for the agents, and runs scheduled jobs. The agents themselves are Claude Code subagents running wherever you run Claude Code; they only ever talk to the app over MCP.

```
                 ┌──────────────────────── Finance Agents app (Next.js) ────────────────────────┐
 Claude Code     │  /api/mcp  ──▶ lib/mcp/*  (core · finance · supplier · intake · orders · reports)│
 F0…F9 + email ──┼──▶  tools call lib/finance/*, lib/crm/*, lib/mail/*, lib/qbo/*                  │
                 │  /finance, /setup (UI)  ──▶ /api/finance/*, /api/setup/*                       │
 Vercel Cron /   │  /api/cron?job=… ──▶ lib/finance/jobs.ts (intake · orders · qbo · crm-sync …)   │
 npm run scheduler                                                                                │
                 │  lib/core/store.ts  ── file (./data/store.json)  or  Postgres (finance_rows)    │
                 │  lib/core/evidence.ts ── ./data/evidence/<sha256>  or  Postgres (finance_blobs) │
                 └───────┬──────────────────────┬──────────────────────┬───────────────────────────┘
                         ▼                      ▼                      ▼
                  QuickBooks Online      Microsoft Graph / IMAP     Your CRM (REST · webhook · MCP · manual)
```

## Store

`lib/core/store.ts`: versioned JSON rows keyed by `(companyId, key)` with optimistic concurrency. Two backends behind one interface:

- **File** (default): `./data/store.json` (`FINANCE_DATA_DIR` to move it). Writes are atomic snapshots (temp file + rename) behind a directory lock. Single machine, single process family; fine for one company on a laptop or a small server.
- **Postgres** (`DATABASE_URL`): one table `finance_rows (company_id, key, version, data jsonb)`, created on first use, `SELECT … FOR UPDATE` inside a transaction per write. Required on Vercel and anything with an ephemeral filesystem. SSL is switched on automatically for `sslmode=require`, Supabase, Neon and RDS URLs.

A `MemoryStore` exists for tests. `upsert`, `createOnce` and `all` are the helpers every module uses; `lease` gives short exclusive locks (token refresh, OAuth callbacks). The app is single-tenant: every row sits under `FINANCE_COMPANY_ID` (default `default`).

Row families (prefixes): `CONFIG#connections` (encrypted settings), `CONFIG#qbo-realm`, `AUTH#owner`, `APIKEY#<hash>`, `TOKEN#QBO`, `TOKEN#CRM`, `OAUTH_STATE#`, `HEALTH#CRM`, `PROJECT#`, `PROJECT_FINANCE#` (overlay), `PROJECT_NOTE#`, `SUPPLIER#`, `DISPUTE#`, `COMMITMENT#`, `CASH_ENTRY#`, `BRIEF#<channel>#`, `TASK#`, `SETTINGS#`, `LEASE#`, plus the intake, orders, ledger and report rows their modules add.

## Evidence

`lib/core/evidence.ts`: content-addressed custody for PDFs and email bodies. Bytes go to `./data/evidence/<company>/<sha256>` (mode 0600) or the Postgres table `finance_blobs`; store rows only ever hold the sha256 and size. Reads verify the hash and refuse ids outside the company's scope. Intake items, disputes and coding decisions reference evidence by id.

## Connections config

`lib/core/config.ts`: everything the setup wizard collects (company, QuickBooks, mail, CRM, AI, notifications, intake flags, setup progress) is one Zod-validated object stored as a single AES-256-GCM blob under a key derived from `APP_SECRET` (`lib/core/crypto.ts`), bound to the company id as additional authenticated data. `getConnections()` decrypts, applies environment overrides (an env var always wins and is never written back) and caches for 15 seconds. `saveConnections(patch)` deep-merges a partial patch into the stored copy. `redactConnections` masks secrets for the UI; `envOverrides()` tells the wizard which fields are pinned by the environment.

## Modules

| Area | Code | Owns |
|---|---|---|
| Core | `lib/core/*` | store, evidence, crypto, auth (owner login, sessions, API keys), config, setup state, shared helpers (`FinanceError`, `invariant`, hashing, name normalisation, dates) |
| CRM | `lib/crm/*` | Project model and the money model (`schedule.ts`: schedule lines, VAT, allocation, totals), projects and the finance overlay, connectors (REST, webhook, MCP, OAuth2), mapping |
| QuickBooks | `lib/qbo/*` | OAuth with encrypted token custody and self-healing refresh, Composio token source, API client (query, reports, batch), reference data, the write gate |
| Mail | `lib/mail/*` | Provider interface, Graph and IMAP implementations, mailbox roles, outbound classification and the drafts-only rule |
| Finance | `lib/finance/*` | Supplier playbook, disputes, commitments, cash entries, payment terms, briefs channel and tasks, job registry and caches; the intake, orders, cashflow / P&L and reports modules in their own folders |
| MCP | `lib/mcp/*` | Auth (API key → principal, scopes) and the tool registrars per group |

## Routes

| Route | Purpose |
|---|---|
| `GET /` | Redirects to `/finance` when setup is complete, else `/setup` |
| `/setup`, `/login`, `/finance` | Owner UI: wizard, login, the finance workspace (Overview, Cashflow, Supplier balances, Supplier invoices, Order acks, Supplier playbook, Disputes, Reports, Agents) |
| `POST /api/auth/login`, `/logout` | Owner session cookie (`fa_session`, signed, 30 days) |
| `GET/POST /api/setup` | Setup state and redacted connections; create the owner; save a wizard step |
| `POST /api/setup/test` | Connection tests: `quickbooks`, `mail` (probes each intake mailbox), `crm` (fetches a sample), `ai` (key check) |
| `GET/POST/DELETE /api/setup/api-keys` | Mint (shown once), list and revoke MCP API keys |
| `/api/oauth/qbo/connect`, `/callback`, `/disconnect` | Intuit consent, realm binding, revoke |
| `/api/oauth/crm/connect`, `/callback` | Generic OAuth2 authorization-code flow for a REST CRM |
| `POST /api/webhooks/crm` | HMAC-verified project upserts and deletes from the CRM |
| `POST /api/webhooks/qbo` | Intuit webhook: verify signature, drop caches |
| `GET /api/cron?job=…` | Run one job or `all` (Bearer `CRON_SECRET`) |
| `GET /api/finance/status` | Setup state, QuickBooks status, last CRM sync |
| `GET/POST /api/finance/briefs`, `/tasks`, `/tasks/[id]` | The briefs channel and task list |
| `GET/POST /api/finance/projects`, `/projects/[id]`, `/projects/[id]/notes` | Projects (manual mode edits), notes |
| `GET/POST /api/finance/crm-sync` | Last sync result; run a sync now |
| `/api/finance/<area>` | Each finance module adds its own routes (suppliers, disputes, intake, orders, cashflow, reports) |
| `GET/POST /api/mcp` | The MCP server |

Every route is `force-dynamic`, authenticates with `requirePrincipal` (session cookie or API key), and returns errors as `{ error: { code, message, retryable } }` with the matching HTTP status via `financeError`. Mutating owner routes also check same-origin.

## MCP

`app/api/mcp/route.ts` builds a stateless Streamable HTTP server with `mcp-handler`, registering the tool groups from `lib/mcp/tools.ts`. `withMcpAuth` verifies the API key on every request (`Authorization: Bearer fa_…` or `x-api-key`) and maps the key's role to scopes (`finance:read`, `finance:write`, `finance:admin`). Tools are named exactly as the briefs reference them; `lead_*` aliases keep older briefs working. Each handler resolves the principal, runs inside `runTool` (Zod and domain errors become `Error: …` text) and attributes writes as `<key name> (agent)`.

## Jobs

`lib/finance/jobs.ts` is a registry: core registers `qbo` (status probe plus ledger warm) and `crm-sync`; each finance module registers its own (`intake`, `intake-log`, `approvals-remind`, `orders`, `reports`) through `module-jobs.ts`. Handlers are idempotent. They are triggered by `GET /api/cron?job=<name>` from Vercel Cron (`vercel.json`) or the local scheduler (`scripts/scheduler.ts`: intake 15 min, orders 30, qbo 15, crm-sync 30). The agents are not jobs: they run in Claude Code on their own timetable and call the MCP tools.

## Data model

- **Project** (`lib/crm/types.ts`): customer, status, `wonValue` (net, ex VAT, excluding installation), `orderFinance` (VAT rate, per-line percentage or amount overrides, installation contract with optional retention), payments with confirmation, invoices, extra costs, supplier orders with acknowledgements, costing snapshots, milestone dates, QuickBooks customer and class mapping, source.
- **Money model** (`lib/crm/schedule.ts`): `resolveSchedule(project)` turns defaults (`company.finance`: deposit 35%, survey 35%, balance 14 days before delivery; installation deposit 20%, Day 1 half the balance, Stage 1 the rest, retention 10%) and overrides into gross lines with due dates derived from milestones, allocates payments (tagged first, then oldest line first) and gives each line a status: n/a, tbc, upcoming, due (within 7 days), overdue, part, paid.
- **SupplierOrder**: the purchase order suppliers quote (`reference`), lines, ordered net, and the acknowledgement the orders job attaches.
- **Overlay** (`ProjectFinanceOverlay`): what this app records on a CRM-owned project; merged on read, untouched by a re-sync.
- **Supplier profile, Dispute, Commitment, CashEntry** (`lib/finance/suppliers.ts`): see `docs/PLAYBOOK.md`.
- **Brief, Task** (`lib/finance/briefs.ts`): the channel agents post to and the list humans work from.

## Caching

In-memory and deliberately short: connections 15 s; QuickBooks reference data 10 min (`invalidateRefData`); Composio token 5 min; mail provider instance per credential set; the ledger copy for the Completion P&L is warmed by the `qbo` job and kept fresh in the store. Modules register their caches with `registerCache`, and any QuickBooks write or Intuit webhook calls `invalidateFinanceCaches()` so the next read is true. Nothing is cached across processes except through the store.
