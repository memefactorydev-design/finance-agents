# Port notes — finance core

Cashflow, supplier balances, ledger / P&L, customer invoices and receipts, commission and the report tabs, ported from the private CRM into this standalone repo. Everything reads the project money model in `lib/crm/*` and the finance store; QuickBooks is read through `lib/qbo/client.ts`.

## What was ported

| Area | File | Source | Notes |
|---|---|---|---|
| Supplier balances | `lib/finance/vendor-balances.ts` | `system/qbo-reports.ts` | `VendorBalanceDetail` report parsed per vendor; dispute register (`DISPUTE#`) + `CONFIG#disputed-bills` cutoff exclude items from the cash buckets. 5-min memory cache, dropped on any QuickBooks write. |
| Ledger by class | `lib/finance/ledger.ts` | `system/qbo-ledger.ts` | Replaces the stub; same exports (`ledgerCostsByClass`, `LedgerCostsByClass`, `matchClasses`, `projectLedgerCosts`, `supplierAliasIndex`, `vendorMatches`) plus `aggregateLedger` (pure, tested). Since date from `cfg.quickbooks.ledgerSince`. 5-min memory / 60-min store copy (`LEDGER#costs-by-class`); a QuickBooks write forces one fresh read. |
| QuickBooks P&L | `lib/finance/qbo-pnl.ts` | `system/qbo-pnl.ts` + `lib/completion.ts` | By-month report, per-class report (`PNL_CLASS#<classId>#<yyyy-mm>` cache), per-month deliveries grouped by designer, and the project completion rule (delivery date for supply-only, Stage 2 sign-off, `completedAt`, inferred fallback). |
| Project P&L | `lib/finance/project-pnl.ts` | `lib/finance/pnl.ts` + the order-ack helpers from `lib/orders.ts` | Sales / Order / Supplier / Completion. Sales and Order snapshots come from `project.costing.sales` / `.order` (`CostStageSummary`); orders from `project.supplierOrders` (lines, `orderedNet`, `ack`). `ackTotals` pairs order and ack lines by code; unacknowledged lines stay at the ordered price. `projectPnl(project)` loads ledger + aliases. |
| Overview | `lib/finance/overview.ts` | `lib/finance/overview.ts` | `listProjects({status:"active"})` replaces the Won-stage query; defaults from `cfg.company.finance`. |
| Cashflow | `lib/finance/cashflow.ts` | `system/cashflow.ts` | Bank book balances via `api.query("Account", …)`, hidden accounts in `SETTINGS#finance_bank_accounts`, 13-week projection (`projectWeeks` is pure and tested). The note that the live bank-feed balance is not in the QuickBooks API is kept. |
| Invoices & receipts | `lib/finance/invoices.ts` | `lib/invoices/raise.ts` + `reconcile.ts` + the `record_payment` / `set_order_finance` tool bodies | Raise / record payment / mark paid / edit / status (void) / delete / auto-reconcile / `reconcileInvoices` / `setOrderFinance`. Numbers `SI-YYYY-NNNN` from `SETTINGS#invoice_sequence` (atomic upsert, per year, never reused). One optimistic write on the project overlay (`PROJECT_FINANCE#<id>`) carries invoices + payments + orderFinance together. |
| Commission | `lib/finance/commission.ts` | `lib/finance/commission.ts` | Generic: `CONFIG#commission` starts empty; designers are added with `set_commission_config`. `commissionLine` is pure and tested. |
| Supplier terms | `lib/finance/supplier-terms.ts` | `system/qbo-supplier-terms.ts` | `applySupplierTerms` (plan / apply) and `markBillDisputed` (the `[DISPUTED …]` memo). `parseTerm` / `dueFor` come from `lib/finance/terms.ts`. |
| Report tabs | `lib/finance/reports/tabs.ts` | `services/finance-sheets.ts` (matrix builders) | Dashboard, Cashflow (90-day daily, colour-coded), Suppliers, P&L by Month, P&L by Class, Commission – <designer>, Loans, Cash Control as plain value matrices; `buildReportTab`, `buildReportTabs`, `toCsv`, `sliceA1`. |
| Google Sheets | `lib/finance/reports/sheets.ts` | `services/finance-sheets.ts` (writer) | OPTIONAL mirror. `GOOGLE_SERVICE_ACCOUNT_JSON` + `FINANCE_SHEET_ID`; `googleapis` is imported lazily. Everything degrades to `configured:false` with the reason. Tabs are created if missing; `_meta` hashes make the sync idempotent. |
| Jobs | `lib/finance/reports/jobs.ts` | cron `sheets` job | `reportsJob` (registered as `reports`): rebuilds the tabs (warming the caches) and mirrors to Sheets when configured. |

## Routes (`/api/finance/…`, auth = session cookie or API key)

- `GET overview?slim=1&includeCompleted=1&pnlLimit=`
- `GET cashflow?fresh=1` · `PATCH cashflow {accountId, hidden}` (admin)
- `GET suppliers` · `POST suppliers {vendorId, vendorName, …}` · `GET|PUT suppliers/[vendorId]`
- `GET disputes?status=&vendor=` · `POST disputes` · `PATCH disputes/[id]`
- `GET commitments?includeInactive=1` · `POST commitments` (admin)
- `GET cash-entries?from=&to=` · `POST cash-entries`
- `GET vendor-balances?fresh=1`
- `GET pnl?projectId= | ?year= | ?month= | ?classId= | ?customer=` (`&fresh=1`)
- `GET projects/[id]/finance` (schedule, invoices, payments, reconciliation) · `PATCH` (order finance) · `POST {action: payment | raise | mark_paid | edit | status | delete}`
- `GET projects/[id]/invoices/[invoiceId]?format=html` (print view; JSON otherwise)
- `GET reports` (tab names + Sheets status) · `GET reports?tab=&format=json|csv&range=A1:D40&year=&month=` · `POST reports {tabs?}` (rebuild / mirror)
- `POST supplier-terms {mode, cutoff, terms}` (admin)

## MCP tools (names unchanged)

`lib/mcp/finance-tools.ts`: get_finance_overview, list_payments_due, get_payment_schedule, list_invoices, raise_invoice, record_payment, set_order_finance, get_project_pnl, mark_invoice_paid, edit_invoice, delete_invoice, check_invoice_totals.
`lib/mcp/supplier-tools.ts`: get_supplier_balances, get_cashflow_outlook, apply_supplier_terms, get_supplier_profile, list_supplier_profiles, upsert_supplier_profile, list_disputes, raise_dispute, update_dispute.
`lib/mcp/report-tools.ts`: sync_finance_sheets, get_sheet_tab, append_cashflow_entry, get_commission_statement, get_monthly_pnl, get_class_pnl, list_commitments, upsert_commitment, set_commission_config, get_finance_sheets_status.

Every tool that took `leadId` accepts `projectId` or `leadId`. `get_quickbooks_status` stays in the core tools.

## Hard rules kept

- **Receipt confirmation.** `record_payment`, `mark_invoice_paid`, `POST …/finance {action: payment | mark_paid}` refuse (`INVOICE_CONFIRMATION_REQUIRED`, 422) without `confirmation {source, by?, at?, ref?}`; `source` must be one of `bank_statement | owner | finance_provider | card_terminal | agent`. The confirmation is stored on the payment and shown on paid invoices. The older `confirmedBy` string is accepted as `source: "agent"`.
- **No client email.** `raise_invoice`'s `emailClient` and the route's `email` field are ignored and the response says so (`NO_EMAIL_NOTE`). No PDF is generated; the HTML print view replaces it.
- **Final customer invoice in QuickBooks is human-only.** Nothing here calls `createInvoice`.
- **Disputed items are excluded** from the cash buckets, the cashflow and the suppliers tab; resolving restarts the clock.
- **Writes to QuickBooks go through the posting gate.** The dispute memo is a dry run with posting off; `apply_supplier_terms` `apply` returns the plan as a dry run with posting off.
- **Admin-only:** amount overrides on raise/edit, deleting a sent/paid invoice, voiding, hiding bank accounts, commitments, commission config, supplier terms. API keys with the `agent` role do everything else, attributed "(agent)" in the project notes.

## Simplified / deviated

- **Timeline events → project notes.** The CRM timeline entries became `addProjectNote` lines (forwarded to the CRM when the connector can).
- **Roles.** The original's admin/manager/designer/installer split collapsed to the repo's `admin` / `agent` principals (`elevated` = admin). Installer-only invoice keys were not ported.
- **Order costing snapshots.** The original kept a snapshot history (Winner file imports, Stage 2 captures). Here Sales and Order are single `CostStageSummary` records on the project (`project.costing`); the "capture on milestone" automation (`capture.ts`) depends on the CRM and was not ported.
- **Order totals.** The original's `totals.cost/sell` per order became `orderedCost(o)` (`orderedNet` or Σ qty × unitCost) and Σ qty × `unitSell`. `ackTotals` pairs lines by code only (the original also paired by position).
- **Commission seed.** No designers are seeded; tier tables are configuration.
- **Commission "won in month" gate** matches `project.designer` against the configured `match` fragments (the original matched the CRM user email).
- **Cashflow tab headings** are generic ("Merchant payouts", "Finance payouts", one line per QuickBooks credit-card account) — the original named specific providers and cards.
- **Google Sheets** never creates the workbook (no Drive scope): share an existing sheet with the service account and set `FINANCE_SHEET_ID`. Charts and per-column number formats were dropped; bold rows and the cashflow colours are written.
- **`/api/finance/export`** became `GET /api/finance/reports?tab=…&format=csv`.
- **Not ported:** `customer-invoices` (prepare / dual-approve a final invoice with S3/KMS evidence) and `customer-schedules` (evidence-backed schedule import) — both depend on the private evidence engine; the final invoice stays a human action in QuickBooks. `suppliers` route `learn` / `seed` actions (QuickBooks-history learning, transcript seed) were not ported.
- **Dashboard "held intake items"** reads `INTAKE#` rows if the intake module writes them; `"n/a"` otherwise.

## Caches

`registerCache` + `onQboWrite` cover the vendor-balance, cashflow and ledger caches. Per-class and monthly P&L reports are cached in the store with the original ages (closed month weekly, current month daily / six-hourly).

## Tests

`npx tsx --test tests/finance.test.ts` — invoices and receipts (sequence, confirmation rule, auto-reconcile, edit/void/delete, order finance), `reconcileInvoices`, the overview, order costs, the four P&Ls, ledger aggregation and matching, the Vendor Balance Detail and P&L parsers, completion dates, cashflow buckets and weeks, commission tiers / holds / split, the report matrices and the Sheets degrade path. All against `MemoryStore`; QuickBooks is never called.
