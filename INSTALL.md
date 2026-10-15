# Install with Claude Code

Open Claude Code in an empty folder, paste the prompt below as one message, and follow along. It installs the app, starts it, walks you through the setup wizard in your browser, installs the eleven agents, registers the MCP server and verifies the connection. Secrets are typed by you into the browser wizard, never into the chat.

Manual steps instead? See the quick start in `README.md` and `docs/DEPLOY.md`.

---

```text
Install Finance Agents (https://github.com/memefactorydev-design/finance-agents) for me, end to end. Work step by step, confirm each step is done before the next, and keep going until the MCP server answers `whoami`.

Rules for this session:
- Never ask me to paste a secret, password, API key, client secret or token into this chat, and never read one out of a file into the chat. Every secret is entered by me in the browser wizard. If a step needs a secret, tell me which screen to type it into and wait for me to say it is done.
- Do not edit .env.local except through `npm run setup`. Do not print its contents.
- Do not install the agents' schedule or turn on live email sending or QuickBooks posting; those are my decisions later.

Steps:
1. Check `node --version` is 20 or newer and `claude --version` works. If Node is missing, tell me how to install it for my OS and stop.
2. `git clone https://github.com/memefactorydev-design/finance-agents` and `cd finance-agents`. If the folder exists, `git pull` instead.
3. `npm install`.
4. `npm run setup`. It writes APP_SECRET, CRON_SECRET and APP_URL to .env.local and prints the next steps. Summarise what it printed without showing values.
5. Start the dev server in the background (`npm run dev`), wait until http://localhost:3000 answers, and tell me it is up. Keep it running for the rest of the session.
6. Open http://localhost:3000/setup for me (or tell me to open it) and walk me through the wizard one screen at a time, explaining what each field is for and waiting for me to confirm each step:
   a. Owner login: my name, email and a password (at least 8 characters). This email is the only identity that can approve agent requests.
   b. Company: name, currency, timezone, VAT number (optional), approver emails, accountant email (optional), internal email domains (staff), the briefs channel name (default internal-finance), and the payment-schedule defaults (deposit %, survey %, installation deposit %, Day 1 %, retention %; the shipped defaults are 35 / 35 / 20 / 50 / 10 with the balance due 14 days before delivery).
   c. QuickBooks: either "Own Intuit app" (client id and secret from developer.intuit.com, redirect URI http://localhost:3000/api/oauth/qbo/callback added to the app, environment sandbox or production, then Connect QuickBooks) or "Composio" (API key and connected account id). Explain docs/QUICKBOOKS.md in two sentences if I ask. Leave "Post bills to QuickBooks" OFF.
   d. Mailboxes: Microsoft 365 app-only (tenant id, client id, client secret, with an Exchange Application Access Policy limiting the app to the finance mailboxes) or IMAP (host, port, user, app password, SMTP host and port, Drafts folder name). Then which addresses are the intake mailboxes, the orders mailbox and the accounts mailbox. Click Test and tell me what it says. Leave live sending OFF.
   e. CRM: manual (projects typed into the app), REST (projects URL, token, optional field mapping and root path), webhook (a shared secret; the app shows the URL my CRM should POST to), or MCP (URL, token, list tool name). Click Test.
   f. AI: an Anthropic API key (or OpenAI, and choose the extractor). Click Test.
   g. API key: create one named "claude-code" with role admin. The key is shown once. Tell me to copy it somewhere safe; do not ask me for it.
7. Install the agents: `mkdir -p ~/.claude/agents && cp agents/*.md ~/.claude/agents/`. List the eleven files you copied.
8. Register the MCP server. Print this exact command for me to run in my own terminal, with the key I copied in step 6g in place of the placeholder, and wait until I say it is done:
   claude mcp add --transport http finance-agents http://localhost:3000/api/mcp --header "Authorization: Bearer <paste the API key here>"
   The server name must be exactly `finance-agents` so the agents' tool names (mcp__finance-agents__*) match.
9. Verify. If the new server is not yet visible to you, tell me to restart Claude Code in this folder (or run /mcp) and resume. Then call the MCP tool mcp__finance-agents__whoami and show me the result: principal, company, which connections are live (QuickBooks connected? mail provider? CRM mode?) and the rules it lists. If anything is not connected, point me to the wizard step that fixes it.
10. First run: ask the subagent finance-f0-orchestration to "run the 06:45 health check" and show me the brief it posted (also visible at http://localhost:3000/finance under Agents).
11. Offer, and only do if I say yes:
    - `npm run scheduler` in the background for the app's own jobs (intake every 15 min, orders every 30, QuickBooks probe every 15, CRM sync every 30);
    - a crontab for the agents from scripts/schedule.cron.example (show me the lines with the real path filled in before installing anything);
    - or Claude Code scheduled tasks for the same timetable.
12. Finish with a short summary: what is running, what is still off (posting, live sending), where the docs are (docs/AGENTS.md, docs/SAFETY.md, docs/PLAYBOOK.md), and the one thing to do next (seed the supplier playbook from Finance ▸ Supplier playbook).
```

---

After the install, read `docs/AGENTS.md` for the go-live gates before enabling any schedule, and `docs/SAFETY.md` before switching on QuickBooks posting or live sending.
