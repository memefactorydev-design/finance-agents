#!/usr/bin/env tsx
// First-run helper: creates .env.local with a fresh APP_SECRET and CRON_SECRET
// (never overwrites existing values), then tells you where to go next. The
// connections themselves are entered in the web wizard at /setup.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const envPath = join(root, ".env.local");
const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const has = (k: string) => new RegExp(`^${k}=.+$`, "m").test(current);
const lines: string[] = [];
if (!has("APP_SECRET")) lines.push(`APP_SECRET=${randomBytes(32).toString("base64")}`);
if (!has("CRON_SECRET")) lines.push(`CRON_SECRET=${randomBytes(24).toString("base64url")}`);
if (!has("APP_URL")) lines.push(`APP_URL=${process.env.APP_URL || "http://localhost:3000"}`);
if (lines.length) {
  writeFileSync(envPath, `${current.trimEnd()}${current ? "\n" : ""}${lines.join("\n")}\n`, { mode: 0o600 });
  console.log(`Wrote ${lines.map((l) => l.split("=")[0]).join(", ")} to .env.local`);
} else console.log(".env.local already has APP_SECRET, CRON_SECRET and APP_URL");
console.log(`
Next:
  1. npm run dev
  2. open http://localhost:3000/setup and work through the wizard
     (owner login → company → QuickBooks → mailboxes → CRM → AI → API key)
  3. copy the agents into Claude Code:  cp agents/*.md ~/.claude/agents/
  4. register the MCP server (use the API key the wizard shows once):
     claude mcp add --transport http finance-agents http://localhost:3000/api/mcp --header "Authorization: Bearer fa_…"
  5. optional schedules: npm run scheduler  (polls mailboxes + QuickBooks)
`);
