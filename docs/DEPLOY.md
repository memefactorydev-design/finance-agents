# Deploy

Three ways to run the app: on your own machine, on any Node server, or on Vercel with Postgres. The agents run in Claude Code separately in every case and need the app's URL and an API key.

## Local (laptop)

```bash
git clone https://github.com/memefactorydev-design/finance-agents
cd finance-agents
npm install
npm run setup        # writes APP_SECRET, CRON_SECRET and APP_URL to .env.local
npm run dev          # http://localhost:3000 → /setup
npm run scheduler    # in a second terminal: intake / orders / qbo / crm-sync on a timer
```

The store is `./data/store.json` and evidence is `./data/evidence/`; back up the `data/` folder. QuickBooks OAuth works against `http://localhost:3000/api/oauth/qbo/callback` when the Intuit app is in development mode (sandbox keys); production keys need https, so use a tunnel or a hosted install for a live company.

## Node server (no Docker)

Any Linux or macOS box with Node 20+:

```bash
npm ci
npm run build
APP_URL=https://finance.example.com npm start           # Next.js on port 3000
```

Put it behind a reverse proxy with TLS (Caddy, nginx) so `APP_URL` is https; set `QBO_REDIRECT_URI` to match if you prefer it explicit. Keep it alive with a process manager (systemd unit, pm2) and run `npm run scheduler` as a second service, or replace the scheduler with system cron hitting `curl -H "Authorization: Bearer $CRON_SECRET" "$APP_URL/api/cron?job=intake"` etc. Set `FINANCE_DATA_DIR=/var/lib/finance-agents` (owned by the service user, mode 700) or use `DATABASE_URL` for Postgres. Back up either nightly.

## Vercel with Postgres

The filesystem on Vercel is ephemeral, so **`DATABASE_URL` is required** (Neon, Supabase, Vercel Postgres via the Marketplace, RDS). Tables are created on first use.

1. Import the repo as a Vercel project (framework: Next.js). No build settings to change.
2. Environment variables (Production, and Preview if you use it): `APP_SECRET`, `CRON_SECRET`, `DATABASE_URL`, `APP_URL=https://<your domain>`. Add `QBO_REDIRECT_URI=https://<your domain>/api/oauth/qbo/callback` and register the same URI in the Intuit app. Everything else can be entered in the wizard and is stored encrypted in Postgres; put it in env instead if you want the secret manager to own it (an env var overrides the wizard).
3. Deploy. Open `https://<your domain>/setup`.
4. **Crons** come from `vercel.json` and need no setup; Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when that env var exists:

   | Path | Schedule | Job |
   |---|---|---|
   | `/api/cron?job=intake` | `*/15 6-19 * * 1-6` | scan intake mailboxes, extract, resolve |
   | `/api/cron?job=orders` | `5,35 6-19 * * 1-6` | order acknowledgements |
   | `/api/cron?job=qbo` | `*/15 * * * *` | QuickBooks token probe and ledger warm |
   | `/api/cron?job=crm-sync` | `*/30 * * * *` | pull projects (REST / MCP modes) |
   | `/api/cron?job=intake-log` | `45 16 * * 1-5` | daily intake log draft |

   The cron route allows up to 300 s (`maxDuration`); the Hobby plan caps function duration lower and runs crons at most once a day on some schedules, so use Pro for the timetable above. Vercel's cron scheduler uses UTC; adjust the hours if your working day is elsewhere.
5. `npm run scheduler` is not needed on Vercel. The agents still run from Claude Code on your machine or a server, pointing at `https://<your domain>/api/mcp`.

Preview deployments share nothing with production unless you give them the same `DATABASE_URL`; give them their own, or none.

## Environment variables

All of these can be set in the wizard instead unless marked required; an env var always wins over the stored value.

| Variable | Required | Purpose |
|---|---|---|
| `APP_SECRET` | yes | 32+ bytes, base64. Encrypts stored connections and tokens, signs sessions. Changing it orphans everything stored |
| `APP_URL` | yes (hosted) | Public URL; OAuth redirects and links in briefs |
| `CRON_SECRET` | yes (hosted) | Bearer token for `/api/cron`; the local scheduler reads it from `.env.local` |
| `DATABASE_URL` | Vercel | Postgres connection string; file store when unset |
| `FINANCE_DATA_DIR` | | Folder for the file store and evidence (default `./data`) |
| `FINANCE_COMPANY_ID` | | Store partition (default `default`) |
| `FINANCE_TIMEZONE` | | Date rendering (default `Europe/London`); the company timezone in the wizard is what the agents use |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | one of | Invoice and acknowledgement extraction; `FINANCE_EXTRACTOR=anthropic|openai`, `FINANCE_EXTRACT_MODEL` to pin a model |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`, `QBO_ENVIRONMENT`, `QBO_REALM_ID` | | Own Intuit app; setting the client id selects `oauth` mode |
| `COMPOSIO_API_KEY`, `COMPOSIO_QBO_CONNECTED_ACCOUNT_ID` | | QuickBooks via Composio; setting the account id selects `composio` mode |
| `FINANCE_POST_BILLS` | | `true` switches the posting gate on (default off: dry runs) |
| `QBO_WEBHOOK_VERIFIER` | | Intuit webhook verifier for `/api/webhooks/qbo` |
| `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET` | | Microsoft 365 app-only mail; selects `graph` |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE`, `IMAP_USER`, `IMAP_PASSWORD`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | | IMAP / SMTP mail; selects `imap` |
| `FINANCE_INTAKE_MAILBOXES`, `FINANCE_ORDERS_MAILBOXES`, `FINANCE_ACCOUNTS_MAILBOX` | | Mailbox roles (comma-separated lists) |
| `FINANCE_LIVE_SEND` | | `true` allows sending to staff / suppliers / partners from the accounts mailbox (default off) |
| `FINANCE_OWNER_EMAIL`, `FINANCE_APPROVER_EMAILS`, `FINANCE_INTERNAL_DOMAINS` | | Owner identity for approvals, approvers, staff domains |
| `CRM_MODE` | | `manual` / `rest` / `webhook` / `mcp` / `none` |
| `CRM_REST_PROJECTS_URL`, `CRM_REST_TOKEN` | | REST pull (URL alone selects `rest`) |
| `CRM_WEBHOOK_SECRET` | | HMAC secret for `/api/webhooks/crm` |
| `CRM_MCP_URL`, `CRM_MCP_TOKEN` | | MCP pull (URL alone selects `mcp`) |
| `FINANCE_INTAKE_ENABLED`, `FINANCE_ORDERS_INTAKE_ENABLED` | | Pause the intake / orders jobs (`false`) |
| `SLACK_WEBHOOK_URL` | | Optional incoming-webhook mirror of the briefs channel |

## Upgrading

`git pull && npm ci && npm run build` then restart. The store is schema-less JSON rows; modules tolerate missing fields and fill defaults on read. Keep `APP_SECRET` the same across upgrades.

## Backups

File store: copy `data/` (store.json plus evidence). Postgres: your provider's backups cover `finance_rows` and `finance_blobs`. There is no other state; `.env.local` holds only the secret and URLs.
