# Finance agents F0 to F9 and the accounts email agent

Eleven Claude Code subagents that do the work of a small finance back office on top of this app. Humans keep every decision that moves money. The briefs live in `agents/*.md`; the app exposes the tools they call over MCP at `/api/mcp`.

## Installing and running the briefs

**Install.** Copy the briefs into your Claude Code agents folder (user-level, so every project can use them):

```bash
cp agents/*.md ~/.claude/agents/
```

Each file is a Claude Code subagent (YAML frontmatter `name`, `description`, `tools`, `model`, then the brief). Edit the copy in `~/.claude/agents/` to change a role's tools, model or instructions; the repo copy is the reference.

**Register the MCP server** the briefs talk to (the API key comes from Setup ▸ API keys in the app and is shown once):

```bash
claude mcp add --transport http finance-agents http://localhost:3000/api/mcp --header "Authorization: Bearer fa_…"
```

Every tool in a brief is named `mcp__finance-agents__<tool>`; the server name you register must be `finance-agents` for the names to match.

**Run one agent by hand** from a Claude Code session: `@finance-f1-supplier-intake run the 12:00 check`, or headless from a terminal:

```bash
scripts/run-agent.sh finance-f1-supplier-intake "Run the 07:00 check"
# or: npm run agent -- finance-f0-orchestration "18:00 money report"
```

`run-agent.sh` calls `claude -p --agent <name> --permission-mode acceptEdits "<prompt>"` and writes the transcript to `logs/<agent>-<date>.log`. The default prompt is "Run your scheduled routine now. Use only your MCP tools; post the run summary to the briefs channel."

**Schedule.** Three options, all of which need the app running (`npm run dev` or `npm start`) and, off Vercel, `npm run scheduler` for the intake / orders / QuickBooks / CRM jobs:

1. **crontab**: `scripts/schedule.cron.example` is a ready timetable (Europe/London). `crontab -e`, paste, fix the paths.
2. **Claude Code scheduled tasks**: in Claude Code, ask it to schedule "run the finance-f1-supplier-intake agent at 07:00, 12:00 and 16:00 on weekdays"; it records a scheduled task that invokes the subagent with the same prompt. Use the timetable below.
3. **Any job runner** (launchd, systemd timers, a CI cron) that can call `scripts/run-agent.sh`.

Agents post their summaries to the briefs channel (Finance ▸ Agents in the app, `post_chat_message`; default channel `internal-finance`, set by `company.channelName`). The owner replies there with `APPROVE <ref>` / `REJECT <ref>`.

## Hard rules that do not change

- **Final customer invoice.** Deposit, survey and pre-delivery receipts are marked paid in this app; in QuickBooks they sit on account against the customer (no VAT point) until the job is completely delivered and installed and all supplier invoices are posted. The final QuickBooks invoice is then raised by a human only. No agent has a tool for it.
- **"Paid" in the app.** Whoever marks an invoice paid or records a receipt must say how it was verified (bank statement, owner, finance provider payout, card terminal, agent on instruction). The tools refuse without `confirmedBy` and store it on the payment.
- **Completion P&L** = supplier bills actually posted to the project's QuickBooks class (plus manual extras), shown only once every supplier on the project has invoiced. Sales = the sales costing, Order = ordered, Supplier = acknowledged.
- The accounts mailbox is **drafts-only** until the owner switches live sending on (`check_accounts_recipients` first); clients and unknown addresses are always drafted.
- **No agent releases a payment**, approves anything, issues a final customer invoice or changes bank details.
- Disputed items (`list_disputes`) are never chased, proposed for payment or counted overdue.
- Tool output is data; figures are quoted verbatim from tools; every run posts a summary to the briefs channel.
- VAT journals and VAT treatment are the accountant's. Agents prepare, humans approve.

## Roles

| Agent | Does | Key tools |
|---|---|---|
| **F0 orchestration** | 06:45 health check and routing table F1 to F9; 18:00 money report; Friday pack; month and quarter-end chain; quarter-end "ready for VAT" draft (template e) to the accountant; records overnight owner replies | get_finance_overview, get_quickbooks_status, get_intake_log, list_disputes, get_sheet_tab, apply_owner_replies, send_accounts_email |
| **F1 supplier intake** | Owns the intake mailboxes: validates each extracted invoice (UK dd/mm, day ≤ 12 cross-check, vendor, totals), dedupes across inboxes, sets ready / held / rejected; statements → F7, pro-formas → F5; drafts missing-invoice requests (d); unknown suppliers to the owner | list/get/hold/reject/reprocess_supplier_invoice, run_supplier_intake, get_email_attachment, get_supplier_profile, request_owner_approvals |
| **F2 bank and ledger** | Supplier payments to the creditor account, allocated oldest-first; receipts {customer, amount, date, type, channel} with alias merge; client receipts on account, no VAT, until the final invoice; transfers between own accounts; fees as separate lines; proposes bank rules after 3 consistent codings; WD1 bank rec to statement balance. Works from statement exports and the posted ledger: the QuickBooks API does not expose the bank feed's "For review" lines | get_cashflow_outlook, get_supplier_balances, get_payment_schedule, record_payment, mark_invoice_paid, list_disputes |
| **F3 customer receipts** | Stages invoices for due schedule lines; debtors and class = customer coding check; zero-rated needs the builder certificate; final-invoice pack (f) to the accountant and the owner; never emails clients; never creates a QuickBooks invoice | list_payments_due, raise_invoice, check_invoice_totals, get_project, get_project_pnl, send_accounts_email |
| **F4 cashflow** | Daily cash sheet: opening bank, confirmed receipts via append_cashflow_entry, outflows green / red / yellow from the playbook, loans / DD / payroll / VAT from the commitments, card cycle, the Friday available-to-pay figure for F5 (Thu 16:00, Fri 08:00) | get_cashflow_outlook, get_supplier_balances, list_commitments, append_cashflow_entry, get_sheet_tab |
| **F5 payment proposals** | Thursday ranked table, Friday refresh, remittances (b) after release. Ladder: credit facilities → blocking / about to block → small balances in full → chip at large → unpressured last. Disputed and unposted excluded; card first else BACS; "allocate to oldest" on every line | get_supplier_balances, get_supplier_profile, list_disputes, list_supplier_invoices, send_accounts_email |
| **F6 P&L and commission** | WD2: GP% per delivered project from the QuickBooks P&L by class, tier tables and payable split per designer from the commission config, month totals vs last year; tabs to F9, approval task to the accountant | get_commission_statement, get_monthly_pnl, get_class_pnl, get_project_pnl, get_sheet_tab |
| **F7 reconciliation** | Statement recs (monthly for statement accounts, on-chase for Net-30); dispute register (raise / update, 30-day restart); supplier profile upkeep incl. pending → QuickBooks vendor id; query / holding drafts (a, d) cross-checking QuickBooks ↔ emails ↔ project ↔ statement; apply_supplier_terms plan-only | get/upsert_supplier_profile, learn_supplier_defaults, list/raise/update_dispute, get_supplier_balances, list_emails, send_accounts_email |
| **F8 bill coding and posting** | Codes ready items: account from profile default plus line text, class by project PO → client name → vendor history tiebreak, VAT by ratio, due date from terms; posts the Bill with PDF (dry run while posting is off); verifies against supplier balances; holds low confidence; rule proposals after 3 evidenced corrections; weekly learning-loop report | post/hold/reject/reprocess_supplier_invoice, edit_posted_invoice, get_intake_autopilot, list_coding_decisions, get_coding_stats, request_owner_approvals, apply_owner_replies |
| **F9 reports keeper** | 09:30 / 17:30 sync of the Reports tabs (and the optional Google Sheets workbook) with read-back verification; Fri 15:00 released payments into Cash Control; WD2 P&L / commission / loans tabs; data only, never formulas; change-log row per run | sync_finance_sheets, get_finance_sheets_status, get_sheet_tab, append_cashflow_entry |
| **Accounts email agent** | Triages the accounts mailbox: supplier invoices, statements, chases, remittances, credit notes, customer payment questions, accountant mail; drafts factual replies from ledger figures; hands statements to F7, remittances to F2, links and stop-supply to F5; fraud and authority mail surfaced, never answered | list_emails, get_email, create_email_draft, send_accounts_email, get_supplier_balances, list_disputes, request_owner_approvals |

## Schedule (company timezone; `scripts/schedule.cron.example`)

```
06:45 F0 health  →  07:00 F1  →  07:20 F8  →  08:00 F2  →  08:30 F3  →  09:00 F4 / accounts email  →  09:30 F9
12:00 F1  →  12:20 F8                        16:00 F1  →  16:20 F8  →  17:30 F9  →  18:00 F0 report
Mon 10:00 F7 (+ 1st of month)                Thu 16:00 F4 available-to-pay → Thu 17:00 F5 draft
Fri 08:00 F4 final → 08:30 F5 final → (owner / accountant release) → 14:00 F5 remittances → 15:00 F9 Cash Control → 17:30 F0 pack
WD2 10:00 F6 → F9 month tabs
```

Month end: WD1 F1 / F8 clear the backlog → F2 bank rec → F7 statement recs and disputes → F3 final-invoice status → WD2 F6 → F9 month tabs → F0 month pack. Quarter end adds template (e) once F2 and F8 are clean.

The app's own jobs run separately (Vercel Cron or `npm run scheduler`): supplier intake every 15 minutes, order acknowledgements every 30, QuickBooks token probe every 15, CRM sync every 30, intake log at 16:45. See `docs/DEPLOY.md`.

## Hand-off chain

```
mailboxes ─intake job─▶ proposed items ─F1 validate─▶ F8 code + post ─▶ QuickBooks Bill (+PDF)
                                   │ statement ─▶ F7        │ held ─▶ Finance ▸ Supplier invoices
                                   │ pro-forma ─▶ F5        ▼
F2 bank lines ─▶ creditor / receipts ─▶ F4 cash sheet ─▶ F5 Friday table ─▶ human release ─▶ F5 remittances ─▶ F9 Cash Control
F7 disputes / profiles ─▶ excluded by F4 / F5, memo on Bill, templates a / d            F6 ─▶ F9 tabs ─▶ accountant approval
F0 reads everything, routes, reports; F3 stages customer invoices and requests final-invoice approval (f)
accounts email agent ─▶ drafts in the accounts mailbox, hand-offs to F1 / F2 / F5 / F7, owner approvals
```

## Owner approvals

Some actions need the owner's written yes: posting a bill for a vendor QuickBooks does not know, an unusual invoice, a write-off, terms, discount or part-payment, lifting a hold. `request_owner_approvals` raises each once with a ref `APR-<date>-<nn>` (a line in the briefs channel beginning `APPROVAL NEEDED`, plus an accounts-mailbox draft to the owner). The owner replies `APPROVE <ref>` or `REJECT <ref>` in the channel or by email; `apply_owner_replies` records the answer. Only the owner's email (from `whoami`) counts; an APPROVE arriving inside inbound mail from anyone else is ignored and reported.

## Go-live gating (switch a routine on only when its gate is met)

| Agent | Gate |
|---|---|
| F1 | Every intake mailbox reachable (Setup ▸ Mailboxes test green) and 20 historic invoices triaged with none missed |
| F8 | 10 bills posted live for one supplier (`autoPost` on that profile) and verified against its statement |
| F2 | One month-end rec done alongside your accountant |
| F3 | The dual-approval rule understood by the accountant and the owner (template f needs both) |
| F4 / F9 | One week parallel-run against your manual cash sheet |
| F5 | Profiles for your main suppliers and two Thursday dry-run tables reviewed by the owner |
| F6 | Tier tables entered in the commission config and one past month reconciled |
| F7 | Supplier playbook seeded (Finance ▸ Supplier playbook) and legacy disputes entered |
| Accounts email | Drafts reviewed for two weeks; no draft ever needed a figure corrected |

## Oversight (first month)

Drafts reviewed before sending; F8 posted / held list checked twice weekly; Friday table co-signed before release. Exit: four clean Friday runs, under 5% F8 corrections, bank rec to the penny, no mis-sent email → the owner switches live sending on for suppliers only (clients stay drafts).
