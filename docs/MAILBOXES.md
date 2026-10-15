# Mailboxes

The agents read supplier invoices, order acknowledgements and accounts correspondence from your mailboxes and leave drafts in the accounts mailbox. Two providers are supported (`mail.provider`): Microsoft 365 through Microsoft Graph with an app-only identity (`graph`), or IMAP / SMTP for everything else (`imap`). Code: `lib/mail/graph.ts`, `lib/mail/imap.ts`, `lib/mail/index.ts`, `lib/mail/outbound.ts`.

## Which mailboxes do what

| Setting | Env | Purpose | Default |
|---|---|---|---|
| `mail.intakeMailboxes` | `FINANCE_INTAKE_MAILBOXES` (comma-separated) | Where supplier invoices, credit notes and statements arrive; the intake job scans them every 15 minutes and F1 reviews the results | the accounts mailbox, or the IMAP login user |
| `mail.ordersMailboxes` | `FINANCE_ORDERS_MAILBOXES` | Where supplier order acknowledgements arrive; the orders job matches them to purchase orders | the intake mailboxes |
| `mail.accountsMailbox` | `FINANCE_ACCOUNTS_MAILBOX` | The one mailbox the agents draft (and, when live, send) from; the accounts email agent triages its inbox | the first intake mailbox |
| `mail.redirectMailboxes` | wizard only | Mailboxes suppliers wrongly send invoices to; with `mail.redirectNotices` on, `create_redirect_notices` drafts a polite "please use the accounts mailbox" note | none |

`list_emails`, `get_email` and `get_email_attachment` only work on the watched mailboxes (intake, orders, accounts); any other address is refused.

Recipient classes for outbound mail (`mail.*` and `company.internalDomains`):

| Setting | Env | Effect |
|---|---|---|
| `company.internalDomains` | `FINANCE_INTERNAL_DOMAINS` | Addresses on these domains are **staff** (sendable when live) |
| supplier profile contacts and `emailDomains` | playbook | **supplier** (sendable when live) |
| `mail.partnerDomains`, `mail.partnerEmails` | wizard only | **partner** allow-list (sendable when live) |
| an email on any project | CRM | **client**: always drafted |
| `mail.blockEmails` | wizard only | always drafted, whatever else matches |
| everything else | | **unknown**: always drafted |

## Drafts only

`mail.liveSendEnabled` (env `FINANCE_LIVE_SEND`) is **off by default** and stays off until you switch it on in Setup ▸ Mailboxes. While it is off every `send_accounts_email` call saves a draft in the accounts mailbox and returns `mode: "draft"` with the reason. When it is on, a message is sent only if every recipient (to and cc) is staff, supplier or partner; one client or unknown address drafts the whole message. `create_email_draft` never sends under any setting. Drafts are threaded replies when `replyToMessageId` is given, and every body ends with a small footer naming the agent that prepared it, so a human sees at a glance what came from the system.

## Microsoft 365 (app-only)

The app authenticates as itself (client credentials) and reads mailboxes by address, so no user has to stay signed in.

1. In Microsoft Entra admin centre → App registrations → **New registration** (single tenant). Note the **Application (client) ID** and **Directory (tenant) ID**.
2. Certificates & secrets → **New client secret**. Copy the value now; it is shown once.
3. API permissions → Add → Microsoft Graph → **Application permissions** → `Mail.ReadWrite`. Add `Mail.Send` only when you intend to switch live sending on. Click **Grant admin consent**.
4. Restrict the app to the finance mailboxes with an Exchange **Application Access Policy** (run in Exchange Online PowerShell as an admin):

   ```powershell
   New-DistributionGroup -Name "Finance Agent Mailboxes" -Type Security -Members accounts@example.com,invoices@example.com,orders@example.com
   New-ApplicationAccessPolicy -AppId <client id> -PolicyScopeGroupId "Finance Agent Mailboxes" -AccessRight RestrictAccess -Description "Finance Agents: finance mailboxes only"
   Test-ApplicationAccessPolicy -AppId <client id> -Identity accounts@example.com   # AccessCheckResult: Granted
   ```

   Without the policy the app could read every mailbox in the tenant. The policy takes up to 30 minutes to apply; add new mailboxes to the group, never widen the policy.
5. In Setup ▸ Mailboxes choose Microsoft 365, enter tenant id, client id and secret (or `M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET`), list the intake, orders and accounts mailboxes, and click **Test**: the app probes each intake mailbox's inbox and reports `ok` or the Graph error (`ErrorAccessDenied` means the access policy does not include that mailbox yet).

Shared mailboxes work without a licence for reading; sending from a shared mailbox needs `Mail.Send` and the policy as above. Attachments are read through Graph's `$value` endpoint; drafts are created with `POST /users/{mailbox}/messages` (or `createReply` for threaded replies), so they appear in the mailbox's Drafts folder for a human to send.

## IMAP (Google Workspace, Fastmail, Zoho, cPanel and others)

One login serves one account. Use a dedicated finance account with an **app password**, not a person's main password.

- **Google Workspace / Gmail:** enable IMAP in Gmail settings, turn on 2-step verification for the account, then create an app password (Google Account → Security → App passwords). Host `imap.gmail.com` port 993 (TLS), SMTP `smtp.gmail.com` port 465. The Drafts folder is `[Gmail]/Drafts`; set `mail.imap.draftsFolder` accordingly.
- **Fastmail:** Settings → Privacy & Security → app passwords; `imap.fastmail.com` 993 / `smtp.fastmail.com` 465; Drafts folder `Drafts`.
- **Zoho, cPanel, Exchange with IMAP enabled:** host and port from your provider; most use `Drafts`.

In Setup ▸ Mailboxes choose IMAP and enter host, port, TLS, user, password, SMTP host and port and the Drafts folder name (or `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE`, `IMAP_USER`, `IMAP_PASSWORD`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`). With IMAP the intake, orders and accounts mailboxes default to the login user; list several only if they share the same credentials (a catch-all or aliases delivered into one account). Drafts are built as MIME with the attachments and `In-Reply-To` set and appended to the Drafts folder; live sends go through SMTP.

## What the agents see

- `list_emails` returns ids, sender, subject, received time (`receivedAt`, ISO) and whether there are attachments; `since`, `search` and `folder` narrow it. Graph searches with `$search`; IMAP searches subject, from and body.
- `get_email` returns the plain-text body (HTML is converted by Graph's text preference or by the MIME parser) truncated at 60,000 characters, plus the attachment list.
- `get_email_attachment` extracts text from PDFs only, with IBANs, sort codes and account numbers redacted; other types return size and a note. Attachments are also stored as content-addressed evidence by the intake job.
- Everything read from mail is untrusted data. The briefs say so and the tool descriptions say so.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Test shows `MAIL_NOT_CONFIGURED` | Provider chosen but a credential is empty |
| Graph `ErrorAccessDenied` on one mailbox | Not in the Application Access Policy group, or the policy has not propagated yet |
| Graph `GRAPH_TOKEN: AADSTS7000215` | Wrong client secret (expired or a secret id pasted instead of the value) |
| IMAP `Invalid credentials` | App password not used, or IMAP disabled on the account |
| Drafts not visible | Wrong `draftsFolder` name for IMAP (check `[Gmail]/Drafts`) |
| `Mailbox … is not one of the watched mailboxes` | The address is not in intake, orders or accounts lists |
