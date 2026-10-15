# Port notes — supplier-invoice intake

What was ported from the private CRM's `lib/finance/system/intake*.ts`, `claude-extractor.ts`, `approvals.ts`, `packages/finance/src/intake.ts` (schema + extractor), the `/api/finance/intake/**` routes and the intake MCP tools, following `docs/PORT-RULES.md`.

## Files

| Target | Source | Notes |
|---|---|---|
| `lib/finance/intake/extractor.ts` | `packages/finance/src/intake.ts` (extractedSchema, InvoiceExtractor), `claude-extractor.ts` | Claude via `@anthropic-ai/sdk` `messages.create` (JSON-only instruction, local zod validation); OpenAI via `chat.completions` + `response_format` json_schema (`zodResponseFormat`). `EXTRACTION#<sha>` cache (attempted / complete / reset), source-quote checks, quote repair, amount-null coercion, bank-detail redaction, `visionExtract` (Claude document block for scanned PDFs). |
| `lib/finance/intake/resolve.ts` | `intake-resolve.ts` | Pure resolver: vendor → class → account → VAT → dates → terms → confidence + reasons. `leadId/leadName` → `projectId/projectName`, `LeadLike` → `ProjectLike`, `leadProjectOpen` → `projectOpen` (uses `status` / `completedAt` / `closedAt`). `isOwnDocument(x, { name, vatNumber })` is pure; the identity comes from `cfg.company`. |
| `lib/finance/intake/learning.ts` | `intake-learning.ts` | Coding decisions, class hints (vendor + global), autopilot switch, promotion / demotion. `leadForClass` → `projectForClass`. |
| `lib/finance/intake/learn.ts` | `intake-learn.ts` | Supplier defaults from QuickBooks bill history (`CURSOR#LEARN`). |
| `lib/finance/intake/log-format.ts` | `intake-log-format.ts` | Pure window / rows / totals / CSV; time zone is a parameter (`TIMEZONE` default) instead of hard-coded London. |
| `lib/finance/intake/log.ts` | `intake-log.ts` + the email template | Builds the day's log, drafts it with `sendFromAccounts` to `cfg.company.accountantEmail || ownerEmail` with the CSV attached (≤ 3 MB). |
| `lib/finance/intake/approvals.ts` | `approvals.ts` | Owner approvals through `postBrief` + `sendFromAccounts` to `cfg.company.ownerEmail`; replies read from `listBriefs` (human authors or approver names) and the accounts inbox (`cfg.company.approverEmails` + owner). No Slack. |
| `lib/finance/intake/intake.ts` | `intake.ts` | Mail scan through `mailProvider()`, evidence custody, dedupe (sha256 + `INDEX#BILL#`), cursors per mailbox, redirect notices, posting, edits of posted bills. |
| `lib/finance/intake/jobs.ts` | cron route | `intakeJob` (run + `applyOwnerReplies`), `intakeLogJob`, `approvalsRemindJob`. |
| `lib/mcp/intake-tools.ts` | `lib/mcp/intake-tools.ts` | Same tool names (see below). |
| `app/api/finance/intake/**` | `app/api/finance/intake/**` | Same shapes; auth through `requirePrincipal` / `financeError`. |
| `tests/intake.test.ts` | `__tests__/intake-resolve.test.ts`, `intake-learning.test.ts`, `intake-log.test.ts`, `claude-extractor.test.ts` | 47 tests, fictional names only. |

## Mappings applied

- **Mail**: every Graph call became `mailProvider()` — `probe`, `listMessages({ since, top })`, `listAttachments`, `getAttachment`, `createDraft({ replyToMessageId })` for the redirect notices. Mailboxes come from `intakeMailboxes(cfg)`; redirect notices only when `cfg.mail.redirectNotices` and the mailbox is in `cfg.mail.redirectMailboxes`; internal domains from `cfg.company.internalDomains`; the "please use …" draft names `accountsMailbox(cfg)` (and the first orders mailbox when one is configured). `FINANCE_REDIRECT_SKIP` became `cfg.mail.blockEmails` (address, domain or `@domain`). The Graph budget is now a generic `CallBudget` (150 provider calls / 25 PDFs per run, 30 notice drafts).
- **Gates**: `FINANCE_INTAKE_ENABLED` → `cfg.intake.enabled`; `FINANCE_POST_BILLS` → `postingEnabled()` (async everywhere); `FINANCE_INTAKE_MAILBOXES` → config.
- **CRM**: `getLeads()` → `listProjects({ includeCancelled: true })` → `ProjectLike` + project-status map (`status`, `signOff2At`/`completedAt`, `closedAt`/`updatedAt`); `getOrders({ supplierId })` → `listSupplierOrders()` loaded once per context and filtered per invoice by supplier id / name (supplier found through `supplierDirectory(listSupplierProfiles())` by sender domain, email or name); `createTimelineEvent` → `addProjectNote`.
- **Own-document detection**: `cfg.company.name` / `cfg.company.vatNumber`; nothing configured → never flagged.
- **Extractor choice**: `cfg.ai.extractor === "openai"` with a key → OpenAI; else Anthropic key → Claude; else OpenAI key → OpenAI; none → every PDF is held `MODEL_NOT_CONFIGURED`. Model `cfg.ai.model` or `claude-sonnet-5-5` / `gpt-4.1-mini`. Vision fallback needs an Anthropic key.
- **Evidence**: `evidence().put(company(), bytes, "application/pdf")` / `.read(company(), id)`.
- **Caches**: the shared resolver context (60 s) and per-vendor bill history (5 min) are registered with `registerCache`.

## Routes

| Route | Method | What |
|---|---|---|
| `/api/finance/intake` | GET | queue (`state`, `vendor`, `limit`), counts, mailbox health + watermarks; `?options=1[&fresh=1]` → vendors / accounts / classes / tax codes |
| `/api/finance/intake` | POST | `{action:"run", mailbox?, limit?, since?, dryRun?}` or `{action:"learn", months?}` |
| `/api/finance/intake/[sha]` | GET | record + its decisions + autopilot verdict; `?pdf=1` streams the PDF |
| `/api/finance/intake/[sha]` | POST | `{action: post \| hold \| reject \| reprocess \| edit_posted, overrides?, reason?, dryRun?, changes?}` |
| `/api/finance/intake/[sha]/pdf` | GET | the PDF (inline) |
| `/api/finance/intake/decisions` | GET | coding decisions + stats (`vendor`, `vendorId`, `since`, `action`, `limit`) |
| `/api/finance/intake/log` | GET | CSV for `date` or `from`/`to`; `&format=json` for rows + totals |
| `/api/finance/intake/autopilot` | GET / PUT | the owner's switch (PUT is admin-only) |

All routes: `requirePrincipal`; POST/PUT also `sameOrigin`. The original's admin/manager split does not exist here (single owner + API keys); only the autopilot PUT needs `admin`.

## MCP tools (`registerIntakeTools`)

`list_supplier_invoices`, `get_supplier_invoice`, `post_supplier_invoice`, `hold_supplier_invoice`, `reject_supplier_invoice`, `reprocess_supplier_invoice`, `run_supplier_intake`, `learn_supplier_defaults`, `get_intake_log`, `send_intake_log`, `create_redirect_notices`, `request_owner_approvals`, `apply_owner_replies`, `get_intake_autopilot`, `set_intake_autopilot` (admin key only), `list_coding_decisions`, `get_coding_stats`, `edit_posted_invoice`.

`get_email_attachment` and `list_chat_messages` from the original intake tool file are **not** registered here: `lib/mcp/core-tools.ts` already provides both names (registering twice would throw).

## Jobs

`intake` (scan, then apply owner replies), `intake-log` (`date`, `to` = comma list of recipients), `approvals-remind`. Params: `limit`, `mailbox`, `since`, `dryRun`, `force`, `by`.

## Simplified or dropped

- **Message categories**: the original tagged posted messages with an Outlook category; the mail provider has no such operation, so it is dropped.
- **Slack DM** to the owner (approval request / reminder): replaced by a brief (Slack-mirrored via the briefs webhook when configured) plus an email draft from the accounts mailbox. Reminders post a brief and draft an email instead of a DM.
- **Reply cursor for briefs**: `CURSOR#APPROVALS#briefs` stores the last `createdAt` instead of a Dynamo sort key.
- **`resetExtraction`**: the store has no delete, so the `EXTRACTION#` row is overwritten with `state: "reset"`, which the extractor treats as absent.
- **`IntakeRecord.attachments: never[]`** (a legacy-engine field) is gone.
- **Supplier directory**: the CRM's supplier table is replaced by supplier profiles (`vendorId`, `vendorName`, `emailDomains`, contacts). A supplier with no profile still gets its orders through `listSupplierOrders` name matching.
- **IMAP**: `since` is day-granular there, so the scan also drops messages older than the watermark instant; everything else (sha dedupe, arrival dedupe) makes re-reads harmless.
- The daily-log greeting is "Dear all" (pass `recipientsName` to change it); the signature is "<company> Accounts".

## Hard rules kept

Nothing is sent: redirect notices, approval requests and the daily log are drafts through the provider / `sendFromAccounts`. No agent approves a new supplier (owner `APPROVE <ref>` required unless a vendorId override is given), nothing is paid, every QuickBooks write goes through `createVendor` / `createBill` / `uploadAttachable` / `updateBill` and is a dry run while `quickbooks.postBills` is off. Mail and PDF text are untrusted data; bank details are redacted before any model call.

## Verification

- `npx tsc --noEmit` — clean.
- `npx tsx --test tests/intake.test.ts` — 47 passed.
- No source company / person / supplier / mailbox names in the new files (checked with the forbidden-name sweep from the port brief over `lib/finance/intake`, `lib/mcp/intake-tools.ts`, `app/api/finance/intake`, `tests/intake.test.ts`; the only addresses are `*.example` / `example.com` in tests).
