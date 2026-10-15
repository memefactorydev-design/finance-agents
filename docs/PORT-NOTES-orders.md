# Port notes — orders (supplier order-acknowledgement intake)

Ported from the private CRM's `lib/finance/system/orders-intake.ts`, `lib/orders/ack-classify.ts`, `lib/orders/ack-extraction.ts`, `lib/orders/ack-apply.ts` (plus the acknowledgement comparison from `lib/orders.ts`), `app/api/finance/orders-intake/route.ts` and `lib/mcp/orders-tools.ts`.

## What it does

The orders mailboxes (`ordersMailboxes(cfg)`) are scanned for supplier order acknowledgements / confirmations — PDF attachments, or the plain email body when a known supplier replies without one. Each document becomes one `ORDERACK#<sha256>` record (the same PDF forwarded twice, or the same email CC'd to two watched mailboxes, is one record with several arrivals). The pipeline is unchanged from the original:

1. **Classify** — `looksLikeAck` keyword heuristics (invoices and delivery notes rejected, bare "acknowledgement" is weak evidence), `isOwnPoCopy` for our own PO PDF, `bodyAckCandidate` as a free pre-filter on the listing (sender + subject + preview) before any mail call is spent on a body, `hasMoneyToken` so a "thanks, received" reply is never sent to a model.
2. **Supplier** — sender address, else sender domain (public mail domains ignored), else the longest supplier name found in the text. Directory = `supplierDirectory(await listSupplierProfiles())`.
3. **Purchase order** — PO reference in subject / file name / text (`PO-YYYY-XXXXX`, strongest signal), else the customer's name or surname (+ postcode) among the supplier's open orders, else the single order for that supplier awaiting acknowledgement. Ambiguity at any step leaves the record **unmatched** with a reason code for a human or agent. A `confirmed` order is never overwritten silently (`ORDER_ALREADY_CONFIRMED`).
4. **Extract** — model call only for acknowledgements: lines with the supplier's position labels, extras (carriage, surcharges, negative discounts), supplier reference, expected date, printed totals.
5. **Apply** — `ack-apply` pairs ordered and acknowledged lines (position first, then code aggregates, then code-less lines by description), lists every difference (qty / unit price over 1p, missing, extra, extra charges, printed-total sanity), computes the acknowledged supplier cost (paired lines at the supplier's prices + unacknowledged lines at the ordered price + extra lines + extras), and persists the ack. Same lines and extras as the ack already on the order → **duplicate**; different → **ACK_REVISED** and applied.

Per-mailbox `CURSOR#ORDERS#<mailbox>` (watermark + ids seen at that timestamp) and `HEALTH#ORDERS#<mailbox>` rows are kept exactly as before; the watermark only advances over fully processed messages.

## Files

| File | Purpose |
|---|---|
| `lib/finance/orders/ack-classify.ts` | Pure heuristics (no imports). |
| `lib/finance/orders/ack-extraction.ts` | `pdfToText` (unpdf), `redactBankDetails`, `parseAckExtraction`, zod schema, `extractAck` (Anthropic / OpenAI). |
| `lib/finance/orders/ack-apply.ts` | `pairOrderAndAck`, `compareOrderToAck`, `ackTotals`, `supplierCostFor`, `buildAck`, `discrepancySummary`, `applyAck`. |
| `lib/finance/orders/orders-intake.ts` | The run (`runOrdersIntakeJob`), record reads, `matchOrderAck`, `rejectOrderAck`, `openOrdersForMatching`, `ordersIntakeHealth`, `readOrderAckEvidence`. |
| `lib/finance/orders/jobs.ts` | `ordersJob(params)` → registered as the `orders` cron job (`limit`, `since`, `force`, `mailbox`, `by`). |
| `lib/mcp/orders-tools.ts` | `registerOrdersTools(server)`. |
| `app/api/finance/orders-intake/**` | Routes below. |
| `tests/orders.test.ts` | 18 cases: heuristics, parsing, comparison, and the intake run end-to-end on `MemoryStore` with a fake mail provider and extractor. |

## Routes (all `requirePrincipal`; writes also check same-origin)

| Route | Purpose |
|---|---|
| `GET /api/finance/orders-intake?state=open\|unmatched\|matched\|not_ack\|duplicate\|rejected\|all&limit=` | Records + per-state counts + mailbox health (original shape). `?orders=all\|<supplierId>` and `?pdf=<sha256>` still work as in the original. |
| `POST /api/finance/orders-intake {action:"run"\|"match"\|"reject", …}` | Original action body. |
| `POST /api/finance/orders-intake/run {since?, limit?, mailbox?}` | Scan now (ignores the enabled gate). |
| `GET /api/finance/orders-intake/health` | Per-mailbox reachability, last check, watermark. |
| `GET /api/finance/orders-intake/orders?supplierId=` | Open purchase orders a reviewer can match to. |
| `GET /api/finance/orders-intake/<sha256>` | One record. |
| `POST /api/finance/orders-intake/<sha256>/match {orderId}` | Attach to an order (re-extracts when the run had no lines). |
| `POST /api/finance/orders-intake/<sha256>/reject {reason}` | Not relevant (never a matched one). |
| `GET /api/finance/orders-intake/<sha256>/evidence` | The stored PDF, or the email body as text, inline. |

## MCP tools (names unchanged)

`list_order_acks`, `match_order_ack`, `reject_order_ack`, `list_open_orders_for_ack`, `run_orders_intake` — any API key minted in Setup (admin or agent); writes are attributed "<name> (agent)".

## Mappings and deviations

- **Mail** — Graph calls replaced by `mailProvider()` (`probe`, `listMessages {since, top}`, `getMessage`, `listAttachments`, `getAttachment`). The 150-call budget now counts provider calls (`mailCalls` in the summary, was `graphCalls`), split across mailboxes as before. Paging is "list since the watermark, process, save the cursor, list again" instead of Graph's `nextLink`; a short page ends the mailbox. IMAP's `SINCE` is day-granular, so messages older than the watermark are dropped client-side; note the IMAP provider returns the newest `top` messages since a date, so a mailbox with more than `top` (10–50) new messages in one run may skip the oldest — a provider limitation, not an intake one.
- **Company facts from config** — the original's hard-coded domain and postal address are gone. Internal senders = `cfg.company.internalDomains` plus the domains of the watched mailboxes (unless on a public mail service). Our own PO copy is recognised by the PO file name + "PURCHASE ORDER" + one marker (company name or internal domain); with no marker configured nothing is treated as our own copy.
- **Supplier directory** — ids are the profile `vendorId`, emails from `contacts`, domains from `emailDomains` (public domains filtered out as before).
- **Order pool** — `listSupplierOrders()` across projects. CRM orders don't always carry `supplierId`, so "this supplier's orders" = same `supplierId` **or** same normalised supplier name. `getOrderById` is a find over the pool.
- **Applying** — no CRM order patch / timeline / channel post / n8n event. `applyAck` writes the ack into the project finance overlay with `setSupplierOrderAck` (the merged order then reads `acknowledged` / `discrepancy`), adds one project note with `addProjectNote`, and posts one line with `postBrief` only when there are differences (meta: projectId, orderId, reference, acknowledged vs ordered cost). The original's `signOffs.ackReview` reset and `supplierCost` cache have no equivalent here (`supplierCostFor` computes it on demand).
- **Extraction** — Anthropic (`@anthropic-ai/sdk`, `cfg.ai.model` or `claude-sonnet-5-5`, JSON-only instruction, tolerant parse, zod validation) when an Anthropic key is set; OpenAI `chat.completions` with a strict `json_schema` response format (`cfg.ai.model` or `gpt-4.1-mini`) when only an OpenAI key is set or `cfg.ai.extractor = "openai"`. Refusals and truncated outputs are reported as `EXTRACTION_FAILED:…` reasons. Bank details (IBAN, sort code, account number) are redacted before the call; the document is marked as untrusted in the prompt. No AI configured → the record is kept with `EXTRACTION_FAILED:AI_NOT_CONFIGURED` / `ORDER_FOUND_BUT_NO_LINES` for a manual match later.
- **Evidence** — `evidence().put/read` (content-addressed; bytes never in the store).
- **Naming** — `leadId/leadName` → `projectId/projectName`; order match source `"lead"` → `"project"`; reason codes `LEAD_ORDERS_AMBIGUOUS` / `LEAD_NAME_AMBIGUOUS` → `PROJECT_ORDERS_AMBIGUOUS` / `PROJECT_NAME_AMBIGUOUS`. `readOrderAckPdf` is kept as an alias of `readOrderAckEvidence`.
- **Gate** — `cfg.intake.ordersEnabled` (env `FINANCE_ORDERS_INTAKE_ENABLED`) replaces the env-only gate; `force` bypasses it (routes and the MCP tool always force, the cron job does not).
- **Roles** — the original restricted the tools and routes to admin/manager sessions; this app's principals are admin or agent and both may use them.
- **Test seams** — `runOrdersIntakeJob(opts, deps)` and `matchOrderAck(…, deps)` accept `{ cfg, provider, extract }` overrides so the whole run is testable without mail or a model.

## Not ported

Winner-import, PO e-mail drafting, the ack query e-mail (`ackQueryText`) and the CRM order sign-off rules — they belong to the CRM's purchasing module, not to finance.
