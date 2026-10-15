# Supplier playbook, dispute register and the Friday pay run

How the company pays and handles suppliers, as data the agents and the Finance UI read. Rows live in the finance store (`lib/finance/suppliers.ts`); nothing here touches QuickBooks except the dispute memo on a Bill.

## 1. Supplier profile (`SUPPLIER#<vendorId>`)

`vendorId` is the QuickBooks Vendor Id, or `pending:<slug>` until F7 or "Learn from QuickBooks history" matches the name. UI: Finance ▸ Supplier playbook. MCP: `get_supplier_profile`, `list_supplier_profiles`, `upsert_supplier_profile`, `learn_supplier_defaults`.

| Field | Meaning | Who reads it |
|---|---|---|
| `vendorName`, `aliases`, `emailDomains`, `contacts` | Names on invoices and emails, sender domains, accounts contacts {name, email, phone, role} | intake resolver, F1, F7, recipient classifier |
| `terms {kind, days}` | `days` = Net N; `eom_next` = end of the following month (statement accounts) | due date on bills, F4, F5 |
| `statementAccount` | Monthly statement account | F7 monthly recs |
| `blockAfterDaysOverdue` | Supplier stops supply at this many days overdue (for example 13) | F4 red rows, F5 ladder |
| `safeDaysOverdue` | Nothing happens for this many days overdue (for example 7) | F5 "unpressured last" |
| `pressure` low / medium / high / critical | How hard they chase | F5 |
| `onHold` | Supply or credit stopped: no new orders, no payment proposed until the owner lifts it | F1, F4, F5 |
| `proformaOnly` | Pay before dispatch: F1 routes pro-formas to F5 | F1, F5 |
| `paymentMethods` bacs / card / amex / paypal, `paymentLinkWording` | Which channels the supplier accepts and how to ask for a link | F5 channel, template (c) |
| `allocateOldestFirst` | Default true; every remittance says so | F2, F5 |
| `defaultAccountName`, `categoryHints` | QuickBooks expense account for most lines; keyword → account learned from history | F8 coding |
| `classHints` | surname / postcode / PO ref → class, learned from owner corrections while the project is open | intake resolver, F8 |
| `autoPost` | Intake may post this supplier's confident bills without review (second gate after the posting gate) | intake job, F8 |
| `creditLimit`, `notes` | Credit available; the why behind every field | F4, F7 |

**Default expense accounts.** Set `defaultAccountName` per supplier to one of your QuickBooks expense accounts. The shipped example set, which F8's line-text overrides also use, is: appliance brands and distributors → **Appliances**; furniture → **Products and Units**; worktop suppliers → **Worktops**; sink and tap suppliers → **Sink and Taps**; fittings and accessories → **Purchase Accessories**; hauliers → **Delivery and Removals**. Line-text overrides: tiles → Tiles, delivery → Delivery and Removals, install → Installation, remedial (or a remedial project order) → Remedials, add-on order → Additionals. Rename these to match your chart of accounts; anything left blank is filled by F7 from QuickBooks history (`learn_supplier_defaults`).

## 2. Commitments (`COMMITMENT#`)

Loans, overheads, payroll, tax and cards with amount, frequency (weekly / monthly / quarterly / once), due day, next due, balance, end date and notes. MCP: `list_commitments`, `upsert_commitment`. F4 projects them into the 13-week outlook; F9 writes the Loans tab. A credit card paid in full on statement day is one commitment; its re-spend shows up as supplier payments by card, so cash is counted once.

## 3. Dispute lifecycle (`DISPUTE#<id>`)

`open → awaiting_supplier → credit_expected → resolved | withdrawn`. Active = the first three.

1. **Raise** (F7, the accounts email agent, or a manager in Finance ▸ Dispute register): `raise_dispute{billId?, vendor, docNumber, amount, project, reason, evidence[]}`. Idempotent per bill (`bill-<id>`); an active dispute on the same bill is returned, not duplicated. With a `billId` and posting on, the QuickBooks Bill memo is prefixed `[DISPUTED - <reason> - raised <date>]`; otherwise the memo step is reported as a dry run.
2. **Effect**: excluded from `get_supplier_balances` buckets, F4 totals, F5 tables, F2 allocations and all chasing. Remittances and supplier emails list the disputed numbers.
3. **Progress**: `update_dispute{id, status, note, outcome, evidence}`; every supplier reply, credit note or project finding goes in as evidence (`kind`: email / blob / note / crm / statement). Cross-check before any status change: QuickBooks bill ↔ supplier emails ↔ project order and notes ↔ statement.
4. **Resolve / withdraw** stamps `resolvedAt` and `clockRestartAt`: the supplier's 30-day clock restarts from resolution, so F5 treats the bill as newly due, not overdue.

## 4. Accounts mailbox templates (a to f)

All plain, short, British English, no emoji; every supplier template carries "We make supplier payments on Fridays." and "Please allocate payments to the oldest open invoices first." Sent through `send_accounts_email`, which drafts everything while live sending is off and always drafts clients and unknown addresses.

| | Template | Used by | Content |
|---|---|---|---|
| a | Supplier query / holding note | F7, accounts email agent | Disputed invoices table (number, amount, query), "please do not chase or allocate against them", undisputed balance and its Friday |
| b | Remittance | F5 (Fri 14:00) | Amount, method, reference, invoices paid, remaining undisputed balance, disputed numbers excluded |
| c | Payment link request | F5 | Card suppliers: amount, invoices, the Friday we intend to pay |
| d | Missing document | F1, F7, accounts email agent | Missing invoices or statement needed before the Friday run |
| e | Ready for VAT | F0 (quarter end) | Internal, to the accountant: bank rec date and balance, intake queue empty, open disputes, zero-rated sales and certificates, where the documents are |
| f | Final-invoice approval | F3 | To the accountant and the owner: delivery date, remedials closed, gross contract, received, final balance, VAT; both approvals required |

## 5. Friday pay-run ritual

| When | Who | What |
|---|---|---|
| Thu 16:00 | F4 | Available-to-pay = opening bank + confirmed receipts before Friday − fixed outflows before Friday − the owner's buffer; names the receipts it depends on |
| Thu 17:00 | F5 | Draft table `supplier | oldest due | amount | channel | reason | after-cash`; template (c) requests for card suppliers without a link |
| Fri 08:00 / 08:30 | F4 → F5 | Final figure, final table; "Proposal for release - nothing has been paid" |
| Fri morning | Owner / accountant | Release in the bank or by card. Agents never release |
| Fri 14:00 | F5 | Template (b) remittance per supplier (drafts); tells F9 the released lines |
| Fri 15:00 | F9 | Released payments into Cash Control; Cashflow tab re-verified |
| Fri 17:30 | F0 | Pay-run pack to the briefs channel |

Priority ladder: 1 credit facilities (the company card in full on statement day; any second card cleared, no new spend) → 2 suppliers blocking or about to block (`blockAfterDaysOverdue` − 3 days, `onHold`, `proformaOnly`, pressure high / critical) → 3 small balances in full → 4 chip at large balances, oldest invoices first → 5 unpressured / `safeDaysOverdue` suppliers last. Disputed and unposted bills are never in the table.

## 6. Allocation rules

- Supplier payments post to the **creditor (Accounts Payable) account** and are allocated to that supplier's **oldest open invoices first**, never to a disputed bill, never as an expense line.
- Customer receipts match the schedule line (deposit / survey / delivery / installation / final); card and merchant fees are separate lines on the same class; refunds and chargebacks are never netted.
- A bill is paid only when it is posted in QuickBooks (unposted = unverified).
- Transfers between your own bank and card accounts are transfers, never income or expense.
- Resolution of a dispute restarts the 30-day clock; a re-issued invoice with new totals is a new bill (`TOTALS_CHANGED` hold), not an edit.
