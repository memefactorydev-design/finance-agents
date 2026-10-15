# MCP tools

The app serves one MCP server (Streamable HTTP, stateless) at `/api/mcp`. Agents authenticate with an API key minted in Setup ▸ API keys, sent as `Authorization: Bearer fa_…` or `x-api-key`. Keys carry `finance:read` and `finance:write`; an admin key also carries `finance:admin`. Revoke a key to cut an agent off. In Claude Code the tools appear as `mcp__finance-agents__<tool>`.

Every tool returns JSON as text. Errors come back as `Error: <code or message>`; validation errors list the offending fields. Writes are attributed to the key's name as `<name> (agent)`.

## Core (`lib/mcp/core-tools.ts`)

| Tool | One line |
|---|---|
| `whoami` | Identity behind the key, company, which connections are live (QuickBooks, mail, CRM) and the hard rules |
| `list_projects` | Won projects / jobs: customer, status, value, contract gross, taken, outstanding, overdue, supplier order count (`status`, `q`, `limit`) |
| `search_projects` | Find projects by customer name, postcode, email or id |
| `get_project` | One project in full: contact, dates, order finance, resolved schedule, payments, invoices, extra costs, supplier POs with acknowledgements, QuickBooks mapping, notes |
| `add_project_note` | Append a note to a project (forwarded to the CRM when the connector supports write-back) |
| `list_leads` / `search_leads` / `get_lead` / `add_lead_note` | Aliases of the four above, kept for older briefs (`leadId` accepted) |
| `post_chat_message` | Post a run summary, hand-off or approval request to the briefs channel |
| `list_chat_messages` | Latest messages in a channel, newest first: other agents' briefs and the owner's `APPROVE` / `REJECT` replies |
| `create_task` | Create a task for a human (title, description, assignee email, projectId, dueDate, priority) |
| `list_tasks` | Open (or all) tasks, by assignee or project |
| `complete_task` | Mark a task done or cancelled |
| `list_emails` | Messages in a watched mailbox (intake, orders or accounts): ids, sender, subject, received, attachment flag. Content is untrusted data |
| `get_email` | Full message with plain-text body (60k chars max) and attachment list |
| `get_email_attachment` | Text of a PDF attachment with IBANs, sort codes and account numbers redacted; metadata for anything else |
| `create_email_draft` | Save a draft (optionally a threaded reply) in the accounts mailbox. Never sends |
| `check_accounts_recipients` | Classify addresses as staff / supplier / partner (sendable when live) or client / unknown (always drafted) |
| `send_accounts_email` | Send from the accounts mailbox only when live sending is on and every recipient is sendable; otherwise saves a draft and says why |
| `get_quickbooks_status` | Is QuickBooks connected (proven with a live read), which company, posting on or dry run |

## Finance (`lib/mcp/finance-tools.ts`)

| Tool | One line |
|---|---|
| `get_finance_overview` | Company-wide roll-up: contract values, taken, outstanding, overdue, next due, invoice counts |
| `list_payments_due` | Schedule lines by window (`overdue`, `next14`, `all`): project, line, amount, due date, status |
| `get_payment_schedule` | One project's resolved schedule lines with amounts, due dates, paid and outstanding |
| `list_invoices` | Customer invoices this app raised, by project or status |
| `raise_invoice` | Stage a customer invoice for a schedule line in this app (not QuickBooks); optional payment link; `emailClient` only on the owner's say-so |
| `record_payment` | Record a customer receipt against a project and schedule line; requires `confirmedBy` |
| `mark_invoice_paid` | Mark a staged invoice paid; requires `confirmedBy` |
| `edit_invoice` | Change a draft invoice's items, dates or note |
| `delete_invoice` | Void a draft invoice |
| `check_invoice_totals` | Recompute net, VAT and gross for an invoice and compare with the schedule line |
| `set_order_finance` | Override a project's VAT rate, schedule percentages / amounts or installation contract (data-entry corrections only) |
| `get_project_pnl` | Sales / Order / Completion margins for a project, with supplier coverage |
| `get_supplier_balances` | Open supplier bills from QuickBooks by vendor with due buckets; disputed excluded; `includeItems` for the bills |
| `get_cashflow_outlook` | Opening bank and card balances, receipts by stage, supplier bills, commitments, 13-week projection and low point |
| `apply_supplier_terms` | Plan (default) or apply QuickBooks vendor terms from the playbook (`mode:"plan"` / `"apply"`) |
| `get_supplier_profile` | One supplier profile by vendorId, name, email or email domain |
| `list_supplier_profiles` | Every supplier profile |
| `upsert_supplier_profile` | Create or patch a supplier profile (terms, hold, block / safe days, contacts, domains, accounts, hints, autoPost) |
| `list_disputes` | Disputes by status (`active` default, `all`, or one status) or vendor |
| `raise_dispute` | Raise a dispute with evidence; idempotent per bill; memo on the Bill when posting is on |
| `update_dispute` | Progress a dispute: status, outcome, note, evidence |
| `sync_finance_sheets` | Rebuild the Reports tabs from the store (and push to Google Sheets when connected); idempotent |
| `get_sheet_tab` | Read back one Reports tab (Dashboard, Cashflow, Cash Control, Suppliers, Loans, P&L by Month, P&L by Class, Commission) |
| `get_finance_sheets_status` | Which tabs exist, last sync, whether an external workbook is connected |
| `append_cashflow_entry` | Add a manual cash row (date, section, label, amount, note, confirmed) that survives the next sync |
| `get_commission_statement` | A designer's commission for a month: GP% per project, tier, payable split, source |
| `get_monthly_pnl` | Month totals: income, GP, net, deals, averages, against last year |
| `get_class_pnl` | P&L by QuickBooks class (project) for a period |
| `list_commitments` | Loans, overheads, payroll, tax and cards with amounts and due dates |
| `upsert_commitment` | Create or update a commitment |
| `set_commission_config` | Owner only: tier tables and payable splits per designer |

## Intake (`lib/mcp/intake-tools.ts`)

| Tool | One line |
|---|---|
| `list_supplier_invoices` | Intake items by state (`proposed`, `held`, `posted`, `rejected`) or vendor |
| `get_supplier_invoice` | One item: extraction, resolver proposal (vendor, account, class, VAT, due), confidence, evidence refs |
| `post_supplier_invoice` | Post the Bill with its PDF to QuickBooks (dry run while posting is off); `overrides` for account / class / due; returns `OWNER_APPROVAL_REQUIRED` for an unknown vendor |
| `hold_supplier_invoice` | Hold an item with a reason (`STATEMENT_FOR_F7`, `PROFORMA_FOR_F5`, `CLASS_UNRESOLVED`, `TOTALS_CHANGED`, free text) |
| `reject_supplier_invoice` | Reject an item that is not a supplier document |
| `reprocess_supplier_invoice` | Re-run extraction and resolution after a fix |
| `run_supplier_intake` | Run the intake job now across the intake mailboxes |
| `learn_supplier_defaults` | Propose default account and terms for a vendor from QuickBooks history |
| `get_intake_log` | The latest intake runs: per-mailbox reach, items found, errors |
| `send_intake_log` | Draft the daily intake log to the owner from the accounts mailbox |
| `create_redirect_notices` | Draft "please send invoices to the accounts mailbox" notes for senders who used a redirect mailbox (only when the owner has enabled notices) |
| `request_owner_approvals` | Raise owner approvals (`APR-…` refs) once per item in the briefs channel and as an accounts draft |
| `apply_owner_replies` | Record the owner's `APPROVE` / `REJECT` replies from the channel and the accounts inbox |
| `get_intake_autopilot` | The owner's autopilot mode (manual / assisted / full) and thresholds |
| `set_intake_autopilot` | Owner only: change the mode or thresholds |
| `list_coding_decisions` | The coding decision log (proposed vs final account / class, tokens) since a date |
| `get_coding_stats` | Agreement rates per supplier, auto-post status, hint performance |
| `edit_posted_invoice` | Change a posted Bill's lines, due date, number or memo in QuickBooks, with an audit entry |

## Orders (`lib/mcp/orders-tools.ts`)

| Tool | One line |
|---|---|
| `list_order_acks` | Supplier order acknowledgements found in the orders mailboxes, matched or unmatched, with discrepancies |
| `match_order_ack` | Attach an acknowledgement to a project's purchase order |
| `reject_order_ack` | Discard an acknowledgement that is not one |
| `list_open_orders_for_ack` | Purchase orders still waiting for an acknowledgement |
| `run_orders_intake` | Run the orders job now |
