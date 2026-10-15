# Port notes — web UI

Ported the Finance section of the private CRM into a standalone app shell, plus the onboarding wizard, project pages and the briefs channel. Everything is client-fetched with a tiny dependency-free data layer (`components/use-api.ts`: `api()`, `useApi()`, `CompanyProvider`/`useCompany()`/`useMoney()`). Nothing under `lib/**` or `app/api/**` was touched.

## Files

| Area | Files |
|---|---|
| Shell | `components/layout/{app-shell,top-bar,theme-toggle}.tsx`, `app/{finance,projects,briefs}/layout.tsx` — server guard (`currentUser()` → `/login?next=…`, or `/setup` when no owner), top bar (Finance / Projects / Briefs / Setup), theme toggle (next-themes), sign out (`POST /api/auth/logout`) |
| Finance | `app/finance/page.tsx`, `components/finance/finance-dashboard.tsx` (KPI strip + Collections / Invoices / P&L / Finance Agents), `finance-agents-panel.tsx` (views with URL state, each mounts once), views: `cashflow-section`, `supplier-balances`, `supplier-invoices-queue` (autopilot switch, decisions log, inline overrides, edit-posted), `order-acks-queue`, `supplier-playbook` (profiles + standing commitments), `dispute-register`, `finance-agents-roster`, `jobs-health`, `quickbooks-card`, `pnl-compare-strip` |
| Money widgets | `mark-paid-popover`, `record-payment-popover`, `confirmation-field` (verification source, required), `raise-invoice-dialog`, `edit-invoice-dialog`, `delete-invoice-dialog`, `extra-cost-dialog`, `invoice-actions`, `money-field`, `status-chip`, `section` (shared card/stat/empty/error/pills), `money.ts` (pure formatters), `types.ts` (JSON shapes) |
| Projects | `app/projects/page.tsx`, `app/projects/[id]/page.tsx`, `components/finance/{project-list,project-form-dialog,project-detail,order-finance-panel,supplier-orders-editor}.tsx` |
| Briefs | `app/briefs/page.tsx`, `components/finance/{briefs-channel,tasks-panel}.tsx` |
| Setup | `app/setup/page.tsx`, `components/setup/{wizard,fields}.tsx`, `components/setup/steps/{owner,company,quickbooks,mailboxes,crm,ai,notifications,agents}-step.tsx` |

`npx tsc --noEmit` is clean for the whole repo at the time of writing.

## Rename applied everywhere in UI types

`leadId → projectId`, `leadName → projectName` (overview rows, cashflow inbound lines, intake `resolution.projectId` / `matchedPo.projectId|projectName`, order-ack `order.projectId|projectName`, open orders for matching, disputes `projectId`). Links go to `/projects/<projectId>`.

## Client-safety rule

Client components value-import only `@/lib/utils` and `@/lib/crm/types` (pure). Everything else from `lib/**` is `import type` only, because `lib/crm/schedule.ts` pulls `node:crypto` through `lib/core/domain.ts`. The schedule maths therefore stays on the server: the project routes must return resolved lines (see below) and the few formulas the client needs (`invoiceTotal`, `netFromGross`, …) are duplicated in `components/finance/money.ts`.

## Error envelope

The UI accepts both `{ error: { code, message, retryable } }` (lib/core/server `financeError`) and the original `{ error: "CODE" }` string form (`errorMessage()` in use-api.ts).

---

## API contract the UI relies on

### Existing routes (already in the repo)

| Call | Body / query | Response used |
|---|---|---|
| `GET /api/setup` | — | `{ state: SetupState, connections: redacted Connections \| null, user: {id,name,role} \| null }` — also read once per page by `CompanyProvider` for company name / currency / finance defaults / signed-in user |
| `POST /api/setup` | `{ owner: { email, name, password } }` | `{ ok }` + session cookie (Owner step; works before login) |
| `POST /api/setup` | `{ connections: DeepPartial<Connections>, step: "company"\|"quickbooks"\|"mailboxes"\|"crm"\|"ai"\|"notifications"\|"agents", finish?: true }` | `{ ok, connections, state }` — masked secrets (`••••abcd`) are sent back untouched and stripped server-side |
| `POST /api/setup/test` | `{ what: "quickbooks"\|"mail"\|"crm"\|"ai" }` | `{ ok, detail?, results?, tools?, count?, sample?, error?, note?, url? }` rendered raw in `TestResult` |
| `GET/POST/DELETE /api/setup/api-keys` | POST `{ name, role: "admin"\|"agent" }`; DELETE `{ id }` | `{ keys }`, `{ key, row }` (key shown once) |
| `GET /api/oauth/qbo/connect` (navigation), `POST /api/oauth/qbo/disconnect` `{}` | | redirect / `{ ok }`; callback returns to `/setup?step=quickbooks&connected=1` (toast) |
| `GET /api/oauth/crm/connect` (navigation) | | redirect |
| `POST /api/auth/logout` | | `{ ok }` |
| `GET /api/finance/status` | | `{ setup: SetupState, quickbooks: QuickBooksStatus, crm: SyncResult \| null }` |
| `GET /api/finance/projects?status=active\|completed\|cancelled\|lost\|all&includeCancelled=1` | | `{ projects: Project[] }` |
| `POST /api/finance/projects` | `{ firstName, lastName, email?, phone?, postcode?, address?, designer?, status?, opsStage?, wonDate?, wonValue?, surveyOrderAt?, deliveryDate?, installStart?, installEnd?, signOff1At?, signOff2At?, supplyOnly?, notes? }` (nulls allowed) | `{ project }` |
| `GET /api/finance/projects/[id]` | | `{ project, schedule: { lines: ResolvedLine[], totals: ScheduleTotals, contractGross, contractNet } }` (`lines[].invoice` populated) |
| `PATCH /api/finance/projects/[id]` | same fields as POST; **`{ supplierOrders: SupplierOrder[] }`** from the supplier orders editor (`ack` omitted — acks are overlay-owned) | `{ project }` |
| `GET/POST /api/finance/projects/[id]/notes` | POST `{ text }` | `{ notes }`, `{ note }` |
| `GET /api/finance/briefs?channel=&limit=` / `POST` | `{ text, channel? }` | `{ briefs, channels }`, `{ brief }` |
| `GET /api/finance/tasks?status=open\|done\|all` / `POST` / `PATCH /api/finance/tasks/[id]` | POST `{ title, description?, assignee?, projectId?, dueDate?, priority? }`; PATCH `{ status: "done"\|"cancelled" }` | `{ tasks }`, `{ task }` |
| `GET/POST /api/finance/crm-sync` | POST `{}` | `SyncResult` |
| `GET /api/cron?job=<name>` | | `{ ok, job, results, ms }`; a **401** means `CRON_SECRET` is set — the Jobs view then shows the curl instead |

### Routes the UI expects from the backend port (original shapes, projectId rename)

| Call | Body / query | Response the UI reads |
|---|---|---|
| `GET /api/finance/overview` | — | `FinanceOverview` exactly as the original `buildFinanceOverview()`: `{ generatedAt, defaults, projects, source, pnlCoverage, kpis{contractNet, contractGross, taken, outstanding, overdue, dueNext14, dueNext30, uninvoicedDue, invoices{draft,sent,paid:{count,value}}, pnl{…}}, collections: CollectionRow[], dueLines: DueLine[], invoices: InvoiceRow[], pnl: PnlRow[] }` with `projectId` instead of `leadId` (types in `components/finance/types.ts`) |
| `GET /api/finance/cashflow[?fresh=1]` | | `CashflowOutlook` (inbound lines carry `projectId`) |
| `PATCH /api/finance/cashflow` | `{ accountId, hidden: boolean }` | `{ settings, report: CashflowOutlook }` |
| `GET /api/finance/vendor-balances[?fresh=1]` | | `VendorBalanceReport` (the original lived at `/api/finance/qbo/vendor-balances`; the brief named `/api/finance/vendor-balances`, which the UI uses) |
| `GET /api/finance/intake?state=open\|proposed\|held\|posted\|duplicate\|not_invoice\|rejected\|all&vendor=&limit=` | | `{ posting, intakeEnabled, state, counts, mailboxes: MailboxHealth[], items: IntakeRecord[] }` — the dashboard badge reads `counts.proposed + counts.held` from `?state=open&limit=1` |
| `GET /api/finance/intake?options=1[&fresh=1]` | | `{ vendors, accounts, classes, taxCodes }` (`{id,name}[]`) |
| `POST /api/finance/intake` | `{ action: "run" }` | `IntakeRunSummary` |
| `POST /api/finance/intake/[sha]` | `{ action: "post", overrides?: ResolveOverrides }` · `{ action: "hold"\|"reject", reason }` · `{ action: "reprocess" }` · `{ action: "edit_posted", changes: PostedEdit }` | `{ item }` |
| `GET /api/finance/intake/[sha]?pdf=1` | | the PDF inline (opened in a new tab) |
| `GET /api/finance/intake/autopilot` / `PUT` | PUT `{ mode?, minConfidence?, requireClass?, requireKnownVendor? }` | `{ posting, autopilot: AutopilotConfig, suppliersOnAutoPost, suppliers }` |
| `GET /api/finance/intake/decisions?limit=300&vendor=` | | `{ decisions: CodingDecision[], stats: DecisionStats }` |
| `GET /api/finance/orders-intake?state=open\|unmatched\|matched\|not_ack\|duplicate\|rejected\|all&limit=` | | `{ mailbox: MailboxHealth (with optional .mailboxes[]), state, counts, items: OrderAckRecord[] }` — badge reads `counts.unmatched` |
| `GET /api/finance/orders-intake?orders=all\|<supplierId>` | | `{ orders: OpenOrder[] }` (`{ id, reference, projectId, projectName, supplierId, supplierName, status, sentAt, createdAt }`) |
| `GET /api/finance/orders-intake?pdf=<sha>` | | PDF / text inline |
| `POST /api/finance/orders-intake` | `{ action: "run" }` · `{ action: "match", sha256, orderId }` · `{ action: "reject", sha256, reason }` | run summary / `{…}` (UI reloads the list) |
| `GET /api/finance/suppliers` | | `{ profiles: (SupplierProfile & {activeDisputes})[], total, pending }` |
| `POST /api/finance/suppliers` | `{ action: "learn" }` | `{ available?, summary? }`; **501** = feature unavailable (shown as a notice). The original `seed` action was dropped. |
| `PUT /api/finance/suppliers/[vendorId]` | partial `SupplierProfile` (`vendorName, aliases, emailDomains, contacts, terms, statementAccount, blockAfterDaysOverdue, safeDaysOverdue, pressure, onHold, proformaOnly, paymentMethods, paymentLinkWording, allocateOldestFirst, defaultAccountName, autoPost, creditLimit, notes`); `vendorId` = QuickBooks id or `pending:<slug>` | `{ profile, created }` |
| `GET /api/finance/disputes?status=active\|all\|<status>` | | `{ status, total, totalAmount, disputes: Dispute[], postingEnabled }` — badge reads `total` |
| `POST /api/finance/disputes` | `{ vendor, amount, reason, docNumber?, billId?, project?, projectId?, raisedAt? }` | `{ dispute, qboMemo: { state, detail? } }` |
| `PATCH /api/finance/disputes/[id]` | `{ status?, note?, outcome?, amount?, evidence? }` | `{ dispute }` |

### Routes that did not exist in the original — **new contract, needs reconciling**

**`GET /api/finance/commitments?includeInactive=1`** → `{ commitments: Commitment[] }`; **`POST /api/finance/commitments`** with `{ id?, name, kind: "loan"\|"overhead"\|"payroll"\|"tax"\|"card", amount, frequency: "weekly"\|"monthly"\|"quarterly"\|"once", dueDay?, nextDue?, balance?, endDate?, notes?, active? }` → `{ commitment }` (maps 1:1 onto `upsertCommitment` in `lib/finance/suppliers.ts`; `active:false` deactivates).

**`POST /api/finance/projects/[id]/finance`** — one route for every money write on a project, discriminated by `action`. The bodies mirror the MCP tools (`set_order_finance`, `record_payment`, `raise_invoice`, `mark_invoice_paid`, `edit_invoice`) so the route and the tools can share one implementation:

| `action` | Body | Notes |
|---|---|---|
| `set_order_finance` | `{ netValue?, vatRate?, installation?: { value: number\|null, retentionApplies?: boolean } \| null, lineOverrides?: [{ key: ScheduleKey, pct?, amountGross?, dueDate?: string\|null, reset?: true }] }` | `installation: null` removes the contract; `reset: true` returns a line to the default split |
| `record_payment` | `{ amount, date, method: PaymentMethod, note?, scheduleKey?, confirmation: { source: "bank_statement"\|"owner"\|"finance_provider"\|"card_terminal", ref: string\|null } }` | server must refuse without `confirmation` and stamp `by`/`at` |
| `raise_invoice` | `{ scheduleKey, dueDate?, note?, paymentLink?, description?, amountGross? }` | `amountGross` rewrites the schedule line; response includes `invoice` |
| `mark_invoice_paid` | `{ invoiceId, paidAt, method, recordPayment: boolean, confirmation: { source, ref } }` | response includes `invoice` and `payment` (null when `recordPayment` is false) |
| `edit_invoice` | `{ invoiceId, description?, dueDate?: string\|null, paymentLink?: string\|null, note?: string\|null, vatRate?, amountGross? }` | only changed keys are sent |
| `set_invoice_status` | `{ invoiceId, status: "sent" \| "void" }` | void frees the schedule line |
| `delete_invoice` | `{ invoiceId }` | response may include `removedPayments` (the auto-recorded payment) |
| `add_extra_cost` | `{ amount, date, category: ExtraCostCategory, description }` | server generates `id`, `addedBy`, `addedAt` |
| `remove_extra_cost` | `{ id }` | |

Every action responds with **`FinanceMutationResult = { project: Project, schedule: { lines, totals, contractGross, contractNet }, invoice?, payment?, removedPayments? }`** — the same `schedule` shape as `GET /api/finance/projects/[id]` — and the UI replaces its state with it (no refetch).

## Simplifications vs the original

- No invoice PDF generation or "email to client" (the original built PDFs and sent from the salesperson's Microsoft 365 mailbox). Invoices here are numbered records with raise / mark paid / mark sent / edit / void / delete; `paymentLink` is kept as a field.
- The original Overview tab was folded into Collections (overdue / due-soon cards above the table); the four tabs are Collections / Invoices / P&L / Finance Agents as briefed.
- The Engine monitor view was dropped (as briefed) and replaced by **Jobs & health** (`GET /api/finance/status` + per-job "run now" via `GET /api/cron?job=…`, curl fallback when `CRON_SECRET` is set).
- Single-owner app: `elevated` checks from the original are gone (the owner can always edit amounts, void and delete). Agent API keys never reach the UI.
- Supplier playbook: "Seed from transcripts" removed; the standing-commitments editor was added to the same view.
- Roster text, schedules and job list are generic (`scripts/schedule.cron.example`, `vercel.json`); agent names are the `agents/*.md` filenames.
- The schedule editor no longer calls `resolveSchedule`/`mergeOrderFinance` on the client; it posts intents to the finance route and renders the returned lines.

## Things to check once the backend lands

1. `GET /api/finance/overview` returning `projectId`/`projectName` (the UI never reads `leadId`).
2. `/api/finance/vendor-balances` path (not `/qbo/vendor-balances`).
3. The two new routes above (`commitments`, `projects/[id]/finance`) and that `PATCH /api/finance/projects/[id]` tolerates `supplierOrders` without `ack`.
4. `GET /api/finance/intake` and `orders-intake` must accept `limit=1` and still return the full `counts` map (used for the Finance Agents badges).
5. `POST /api/finance/suppliers {action:"learn"}` should answer 501 when QuickBooks history learning is not available (the UI shows a notice instead of an error).
