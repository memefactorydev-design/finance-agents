# QuickBooks Online

The app reads your ledger (vendors, accounts, classes, tax codes, terms, customers, bills, the P&L by class) and, when you switch the posting gate on, writes supplier Bills with their PDFs, Bill updates and new Vendors. Nothing else is ever written. Code: `lib/qbo/client.ts`, `lib/qbo/oauth.ts`, `lib/qbo/composio.ts`, `lib/qbo/status.ts`.

Two ways to connect (`quickbooks.mode`): your own Intuit app (`oauth`) or Composio (`composio`).

## Option A: your own Intuit app

1. Sign in at developer.intuit.com and create an app (QuickBooks Online and Payments → Accounting scope). You get a **Client ID** and **Client Secret** for Development (sandbox) and Production separately.
2. Under the app's **Redirect URIs** add exactly `<APP_URL>/api/oauth/qbo/callback`, for example `http://localhost:3000/api/oauth/qbo/callback` locally and `https://finance.example.com/api/oauth/qbo/callback` hosted. Intuit requires https for production and allows localhost for development.
3. Scope: the app requests only `com.intuit.quickbooks.accounting`. Nothing else is needed.
4. In Setup ▸ QuickBooks choose "Own Intuit app", pick the environment (`sandbox` or `production`), enter the client id and secret, confirm the redirect URI (it defaults to `<APP_URL>/api/oauth/qbo/callback`), save, then click **Connect QuickBooks**. You are sent to Intuit, choose the company, and land back on the wizard with `connected=1`.

Or from the environment: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`, `QBO_ENVIRONMENT=sandbox|production`, optional `QBO_REALM_ID`. Setting `QBO_CLIENT_ID` switches the mode to `oauth`.

**Realm binding.** The company (realm) you pick at the first consent is written once to the store (`CONFIG#qbo-realm`) with its environment. Every later consent and every token use must match it; a different company or a sandbox / production mix-up fails with `QBO_REALM_MISMATCH` / `QBO_ENVIRONMENT_MISMATCH`. Pin a realm up front with `quickbooks.realmId` if you prefer.

**Tokens.** Access and refresh tokens are stored encrypted (`TOKEN#QBO`) under `APP_SECRET`. Refreshes happen under a store lease so concurrent callers do not race; a refresh whose outcome was lost (timeout, crash) is retried on a schedule (immediately, then 5 minutes doubling to an hour, up to 20 attempts) and the status shows `recovery {attempts, lastAt, lastError}`. Only a definitive rejection from Intuit (400 / 401 / 403) or an exhausted budget sets `reauth_required`, the one state that needs a human to click Connect again. Intuit's refresh tokens expire after 100 days of no use; a scheduled job (`/api/cron?job=qbo`, every 15 minutes) keeps the connection warm.

**Disconnect** (Setup ▸ QuickBooks ▸ Disconnect, `/api/oauth/qbo/disconnect`) revokes the refresh token at Intuit and marks the row disconnected.

## Option B: Composio

If you already use Composio, let it own the OAuth dance. Create a QuickBooks connection in Composio, then in Setup ▸ QuickBooks choose "Composio" and enter your **Composio API key** and the **connected account id** (or `COMPOSIO_API_KEY` + `COMPOSIO_QBO_CONNECTED_ACCOUNT_ID`; the latter switches the mode to `composio`). The app reads the connection's access token from Composio (cached 5 minutes), asks Composio to refresh on a 401, and calls Intuit's API directly with it. The realm comes from the connection parameters or, failing that, from a `companyinfo` probe. The connection must be `ACTIVE` in Composio.

## Sandbox vs production

- **Sandbox** (`QBO_ENVIRONMENT=sandbox`) talks to `sandbox-quickbooks.api.intuit.com` with the app's Development keys and a sandbox company Intuit gives you. Use it to prove extraction, coding and posting end to end with the posting gate on; nothing real is touched.
- **Production** talks to `quickbooks.api.intuit.com` with the Production keys. Intuit only issues production keys once the app's settings (name, URLs, email) are complete.

The environment is part of the realm binding, so switching means disconnecting and reconnecting.

## The posting gate and dry runs

`quickbooks.postBills` (env `FINANCE_POST_BILLS`) is **off by default**. While it is off every write (`createVendor`, `createBill`, `updateBill`, `uploadAttachable`) returns the exact payload it would have sent, marked as a dry run; the intake queue, F8's reports and `get_quickbooks_status` (`posting: false`) all say so. Review a week of dry runs, then switch it on in Setup ▸ QuickBooks. A second gate, per supplier, is `autoPost` on the supplier profile: without it the intake job never posts on its own, F8 or a human does.

## What the app reads

Reference data (`qboRefData`, cached 10 minutes, refreshed on demand): active Vendors with their terms and emails; Expense, Cost of Goods Sold and Other Expense Accounts; Classes; TaxCodes with rates; Terms; active Customers. Bills, Vendor Credits and Purchases since `quickbooks.ledgerSince` (default 2025-01-01) with a ClassRef feed the Completion P&L per class; supplier balances come from open Bills; CompanyInfo proves the connection (`get_quickbooks_status` is only `connected` after that read succeeds). API calls use minor version 75, retry once on 401 after a forced refresh, and back off once on 429 / 503.

## What the API cannot see

- **The bank feed.** Lines waiting in Banking ▸ For review and the live bank-feed balance are not in the QuickBooks Online API. The app and F2 work from posted transactions and the book balance, plus the statement export the owner provides; a human clicks Add / Match in QuickBooks.
- **Attachments on existing transactions** are not read back; the app only uploads them.
- **Invoices** are never created, so customer invoicing stays in your hands (see `docs/SAFETY.md`).

## Webhooks (optional)

Register `<APP_URL>/api/webhooks/qbo` in the Intuit app's webhook settings and set `QBO_WEBHOOK_VERIFIER` to the verifier token Intuit shows. The route checks the `intuit-signature` HMAC and then only invalidates the app's caches so the next read is fresh. Nothing is written in response to a webhook.
