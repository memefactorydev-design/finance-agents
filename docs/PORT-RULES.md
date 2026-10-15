# Port rules (shared contract for every module)

This repo is a **public, standalone** port of a private finance system. Every module follows these rules.

## Never in this repo
- No real company, person, supplier, customer, mailbox, domain, VAT number, phone, bank detail, Slack id, server name, API key or token. Examples in docs use `example.com`, "Acme Worktops", "the owner", "the accountant".
- No CRM-specific code: no `@/lib/db/*`, DynamoDB, Vercel Blob, KMS, Slack client, Google Sheets as a hard dependency, `@sheraton-os/*` imports.
- No hard-coded mailboxes, channels or domains: read them from `getConnections()` (`lib/core/config.ts`).

## Building blocks (use these, do not reimplement)
- Store: `financeStore()`, `company()`, `evidence()` from `lib/core/server.ts`; `all/upsert/createOnce` from `lib/core/store.ts`.
- Errors/helpers: `FinanceError`, `invariant`, `hash`, `bytesHash`, `r2`, `truthy` from `lib/core/domain.ts`; `normName`, `localDate`, `shiftDays`, `nextFriday`, `domainOf` from `lib/core/text.ts`.
- Config: `getConnections()` → `cfg.company`, `cfg.quickbooks.postBills`, `cfg.mail.*`, `cfg.crm.*`, `cfg.ai.*`, `cfg.intake.*`.
- QuickBooks: `qboClient()`, `qboRefData()`, `taxCodeConfig()`, `vendorByName`, `accountByName`, `classByCustomer`, `classByCustomerFuzzy`, `tokenNear`, `termById`, `vatKindFor`, `createVendor`, `createBill`, `findBill`, `updateBill`, `updateBillFields`, `uploadAttachable`, `postingEnabled()`, `invalidateRefData`, `onQboWrite` from `lib/qbo/client.ts`; `quickBooksStatus()` from `lib/qbo/status.ts`.
- Mail: `mailProvider()`, `intakeMailboxes(cfg)`, `ordersMailboxes(cfg)`, `accountsMailbox(cfg)` from `lib/mail/index.ts` (interface in `lib/mail/types.ts`); `sendFromAccounts`, `classifyRecipients` from `lib/mail/outbound.ts`.
- Projects (the CRM's jobs): `listProjects`, `getProject`, `requireProject`, `searchProjects`, `listSupplierOrders`, `setProjectPayments`, `setProjectInvoices`, `setProjectExtraCosts`, `setProjectOrderFinance`, `setProjectQbo`, `setSupplierOrderAck`, `addProjectNote` from `lib/crm/projects.ts`; types in `lib/crm/types.ts`; money model in `lib/crm/schedule.ts` (`resolveSchedule`, `scheduleTotals`, `contractGross`, `FINANCE_DEFAULTS`…). Finance defaults live in `cfg.company.finance`.
- Suppliers/disputes/commitments/cash entries: `lib/finance/suppliers.ts`. Terms: `lib/finance/terms.ts`.
- Briefs channel + tasks: `postBrief`, `listBriefs`, `createTask`, `listTasks` from `lib/finance/briefs.ts`.
- Auth in routes: `requirePrincipal(request)`, `requireAdmin(p)`, `actorName(p)` from `lib/core/auth.ts`; errors via `financeError(e)` from `lib/core/server.ts`. MCP helpers in `lib/mcp/auth.ts` (`principalFrom`, `ok`, `fail`, `runTool`, `actorName`, `Extra`).
- Caches: register in-memory caches with `registerCache(fn)` from `lib/finance/caches.ts`.

## Naming
- `lead` → `project` everywhere: `leadId` → `projectId`, `leadName` → `projectName`, `getLeadById` → `getProject`. Keep QuickBooks words (vendor, class, bill) as they are.
- Route paths stay under `/api/finance/<area>` with the same shape as the original where one existed.
- MCP tool names stay exactly as in the original system (the agent briefs reference them).

## Style
- TypeScript strict, Next.js 14 App Router (`params` is sync, `cookies()` is sync). `export const dynamic = "force-dynamic"` on routes.
- Comments explain the business rule, not the code. British English. Keep the hard rules: no agent pays, approves, or creates customer invoices; drafts only from the accounts mailbox; disputed items excluded.
- Finish with `npx tsc --noEmit` clean for your files and a `docs/PORT-NOTES-<module>.md` listing what was ported, what was simplified, and the routes/tools exposed.
