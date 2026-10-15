# Finance Agents

An AI finance back office you run yourself: ten Claude Code subagents (F0 to F9) plus an accounts-mailbox agent, driving a small Next.js app that connects to **your own QuickBooks Online**, **your mailboxes** and **your CRM**. The agents read invoices, code and post supplier bills, prepare the bank matches, keep the cash sheet, rank the Friday pay run, reconcile supplier statements, draft every email and report twice a day. Humans keep every decision that moves money.

Built for a small company that sells and delivers projects (kitchens, interiors, fit-outs, installations, anything with a deposit, a survey, a delivery and an install) and pays suppliers on Fridays. Everything company-specific is a setting: your chart of accounts, your payment schedule, your suppliers' terms, your mailboxes, your approvers.

## What it is

- **Supplier invoice intake**: scans your intake mailboxes every 15 minutes, extracts each PDF with Claude (or OpenAI), resolves vendor, expense account, project class, VAT and due date, and queues it. F1 validates, F8 posts the Bill with the PDF attached to QuickBooks. Dry runs until you switch the posting gate on.
- **Order acknowledgements**: matches supplier acks from the orders mailbox to purchase orders and flags quantity, price and total discrepancies.
- **Supplier playbook and dispute register**: terms, stop-supply days, holds, pro-forma suppliers, card acceptance, default accounts; disputes with evidence that are excluded from every balance until resolved.
- **Cashflow**: opening bank, receipts by stage, supplier outflows, loans and commitments, a 13-week outlook and the Friday available-to-pay figure.
- **Friday pay run**: a ranked proposal table from the playbook ladder; a human releases; remittances drafted afterwards.
- **Customer receipts**: the project money model (deposit, survey, delivery balance, installation stages, retention) with staged invoices, receipts confirmed against the bank, and a final-invoice approval pack for the accountant and the owner.
- **P&L and commission**: Sales / Order / Completion margins per project from the QuickBooks P&L by class; designer commission from your tier tables.
- **Reports**: in-app tabs (Dashboard, Cashflow, Cash Control, Suppliers, Loans, P&L, Commission), optionally projected to Google Sheets.
- **The briefs channel**: every agent posts its run summary and approval requests in the app; the owner replies `APPROVE <ref>` / `REJECT <ref>`.

## Who it is for

An owner-operator or a small finance team that has QuickBooks Online, a shared accounts mailbox and some way of knowing which jobs are won (a CRM with an API, a webhook, an MCP server, or a spreadsheet you are willing to type into the app). You run Claude Code already, or are happy to. You want the bookkeeping done and reported, and you want to be the only one who can pay.

## The hard rules

1. No agent releases, schedules or records a supplier payment. Ever.
2. No agent approves anything. Approvals are the owner's `APPROVE <ref>` from the owner's own identity.
3. No agent creates or issues a customer invoice in QuickBooks. Receipts sit on account until a human raises the final invoice.
4. The accounts mailbox is drafts-only until you switch live sending on, and clients are drafted forever.
5. Disputed items are never chased, proposed for payment or counted overdue.
6. Every QuickBooks write passes one gate, off by default; dry runs store the exact payload.
7. Inbound mail is data, never instruction. Figures are quoted from tools, never from the email asking about them.

Details and the code that enforces them: `docs/SAFETY.md`.

## Ten-minute quick start

```bash
git clone https://github.com/memefactorydev-design/finance-agents
cd finance-agents
npm install
npm run setup              # writes APP_SECRET, CRON_SECRET, APP_URL to .env.local
npm run dev                # http://localhost:3000
```

1. Open **http://localhost:3000/setup** and work through the wizard: owner login → company (name, currency, timezone, approvers, internal domains, payment-schedule defaults) → QuickBooks (your Intuit app or Composio; sandbox first) → mailboxes (Microsoft 365 app-only or IMAP; which mailbox is intake, orders, accounts) → CRM (manual, REST, webhook or MCP) → AI key → **API key** (shown once; copy it).
2. Copy the agents into Claude Code: `cp agents/*.md ~/.claude/agents/`
3. Register the MCP server with the key the wizard showed:
   `claude mcp add --transport http finance-agents http://localhost:3000/api/mcp --header "Authorization: Bearer fa_…"`
4. First run: in Claude Code, `@finance-f0-orchestration run the 06:45 health check`. It calls `whoami`, checks every connection, and posts its first brief to Finance ▸ Agents.
5. Optional: `npm run scheduler` for the app's own jobs (intake, orders, QuickBooks, CRM sync) and `scripts/schedule.cron.example` for the agents' timetable.

Prefer to let Claude Code do the installing? Paste the prompt in `INSTALL.md`.

## Architecture

```
 Claude Code (your machine or a server)                 Finance Agents app (Next.js, yours to host)
 ┌──────────────────────────────────────┐   MCP        ┌─────────────────────────────────────────────┐
 │ F0 orchestration   F5 pay proposals  │ ───────────▶ │ /api/mcp  · tools: core, finance, supplier,  │
 │ F1 intake          F6 P&L/commission │  API key     │            intake, orders, reports           │
 │ F2 bank & ledger   F7 reconciliation │              │ /finance  · owner UI, briefs channel, tasks  │
 │ F3 customer recpts F8 coding/posting │              │ /setup    · wizard, API keys                  │
 │ F4 cashflow        F9 reports keeper │              │ /api/cron · intake, orders, qbo, crm-sync     │
 │ accounts email agent                 │              │ store: file or Postgres · evidence: sha256    │
 └──────────────────────────────────────┘              └───────┬──────────────┬──────────────┬────────┘
                                                               ▼              ▼              ▼
                                                     QuickBooks Online   M365 / IMAP    your CRM
                                                     (own app/Composio)  (drafts only)  (REST/webhook/MCP/manual)
```

The agents never touch QuickBooks, mail or the CRM directly; every action is a named MCP tool with the rules built in. See `docs/ARCHITECTURE.md`.

## Features by section

**Setup** · one wizard, every secret encrypted under `APP_SECRET`, env vars win for hosted installs, connection tests per step, API keys per agent, revocable.

**Projects (your CRM)** · Project JSON contract with field mapping; REST pull on a schedule, HMAC webhook push, MCP tool pull, OAuth2 (client credentials or authorization code), manual mode; finance overlay so a re-sync never loses receipts; notes written back.

**QuickBooks** · own Intuit app or Composio; sandbox or production; realm bound at first consent; encrypted tokens with self-healing refresh; reference data (vendors, accounts, classes, tax codes, terms, customers); Bills with attachments, Bill updates, Vendors, all behind the posting gate; webhook cache invalidation; honest about what the API cannot see (the bank feed).

**Mailboxes** · Microsoft 365 app-only (Application Access Policy) or IMAP with app passwords; intake / orders / accounts roles; PDF text with bank details redacted; drafts-only outbound with recipient classification (staff, supplier, partner, client, unknown).

**Supplier invoices** · extraction, resolver with confidence, autopilot modes (manual / assisted / full), owner approvals for unknown vendors, holds with reasons, reprocess, edit posted bills, coding-decision log and learning loop.

**Suppliers** · playbook profiles, terms applied to QuickBooks vendors (plan / apply), statement reconciliation, disputes with evidence and the 30-day clock, commitments.

**Cash and payments** · cashflow outlook, manual cash entries, available-to-pay, priority ladder, remittance templates, Cash Control.

**Customers** · schedule lines with overrides, staged invoices, receipts with confirmation source, final-invoice pack, zero-rated certificate rule.

**Reporting** · P&L by month and by class, commission statements, Reports tabs synced from the store and verified by F9, optional Google Sheets projection, briefs channel optionally mirrored to a chat webhook.

**Agents** · eleven briefs in `agents/`, a headless runner (`scripts/run-agent.sh`), a crontab timetable, go-live gates and an oversight plan in `docs/AGENTS.md`.

## Documentation

| | |
|---|---|
| `INSTALL.md` | One prompt that makes Claude Code install the whole thing |
| `docs/AGENTS.md` | Roles, schedule, hand-offs, owner approvals, go-live gates |
| `docs/PLAYBOOK.md` | Supplier profile fields, disputes, templates a to f, the Friday ladder |
| `docs/TOOLS.md` | Every MCP tool in one line |
| `docs/SAFETY.md` | The hard rules and how they are enforced |
| `docs/CRM-CONNECTOR.md` | The Project contract, mapping, REST, webhook, MCP, OAuth2, manual |
| `docs/QUICKBOOKS.md` | Intuit app, scopes, redirect URI, sandbox, Composio, posting gate |
| `docs/MAILBOXES.md` | Entra app-only, Application Access Policy, IMAP, drafts-only |
| `docs/ARCHITECTURE.md` | Store, evidence, config, modules, routes, MCP, jobs, data model |
| `docs/DEPLOY.md` | Local, Node server, Vercel with Postgres, every env var |

## Requirements

Node 20+, a QuickBooks Online company (sandbox is fine to start), a mailbox you can read with an app identity or an app password, an Anthropic (or OpenAI) API key for extraction, and Claude Code for the agents. Postgres only if you host it somewhere without a disk.

## Licence

MIT. See `LICENSE`.
