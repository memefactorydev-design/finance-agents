# Contributing

Thanks for helping. This is a small, opinionated codebase; the rules below keep it that way.

## Ground rules

- Read `docs/SAFETY.md` first. Pull requests that let an agent pay, approve, send to a client, or create a customer invoice will not be merged, however convenient.
- Nothing company-specific: no real names, suppliers, domains, mailboxes, hosts or keys in code, docs, tests or fixtures. Use `example.com`, "Acme Worktops", "the owner", "the accountant".
- Settings come from `getConnections()` (`lib/core/config.ts`), never from a hard-coded value. If you need a new setting, add it to the Zod schema with a default, to `.env.example` if it has an env override, and to `docs/DEPLOY.md`.
- MCP tool names are a contract with the agent briefs. Do not rename one; add aliases if you must.
- Every QuickBooks write goes through the write gate. Every email leaves through `sendFromAccounts` or `createDraft`.

## Working on it

```bash
npm install
npm run setup && npm run dev
npm run typecheck      # tsc --noEmit, must be clean
npm test               # tsx --test tests/*.test.ts
```

Style: TypeScript strict, Next.js 14 App Router, British English in comments and copy, comments explain the business rule rather than the code, no em-dashes. Keep files small and dependency-free where `lib/core/domain.ts` and `lib/core/text.ts` already provide the helper.

## Adding a module

Put it under `lib/finance/<module>/` with its own `jobs.ts` (registered in `lib/finance/module-jobs.ts`), its MCP tools in `lib/mcp/<module>-tools.ts` (registered in `lib/mcp/tools.ts`), routes under `app/api/finance/<module>/`, and a one-line entry per tool in `docs/TOOLS.md`. If an agent should use it, update the brief in `agents/` and the role table in `docs/AGENTS.md`.

## Pull requests

One concern per PR, a short description of the business rule it implements or fixes, and the manual steps you took against a sandbox QuickBooks company and a test mailbox. Screenshots of the wizard step are welcome when you touch setup.

## Reporting a security issue

Email the maintainer listed in `package.json` rather than opening a public issue. Please do not include real ledger data or mailbox contents in reports.
