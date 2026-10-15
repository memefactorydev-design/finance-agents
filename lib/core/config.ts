// Connections: everything the setup wizard collects (company, QuickBooks,
// mailboxes, CRM, AI keys, notifications). Stored encrypted as a single blob
// (CONFIG#connections) under APP_SECRET; any matching environment variable
// wins over the stored value so hosted deployments can keep secrets in env.
import { z } from "zod";
import { appCipher, appSecretPresent } from "./crypto";
import { company, financeStore } from "./server";
import { upsert } from "./store";
import { truthy } from "./domain";

export const scheduleKeys = ["deposit", "survey_payment", "delivery_balance", "install_deposit", "install_day1", "install_stage1", "retention"] as const;

export const connectionsSchema = z.object({
  company: z.object({
    name: z.string().default(""),
    currency: z.enum(["GBP", "EUR", "USD"]).default("GBP"),
    timezone: z.string().default("Europe/London"),
    vatNumber: z.string().nullable().default(null),
    ownerEmail: z.string().default(""),
    approverEmails: z.array(z.string()).default([]),
    accountantEmail: z.string().nullable().default(null),
    internalDomains: z.array(z.string()).default([]),
    channelName: z.string().default("internal-finance"),
    finance: z.object({
      defaultVatRate: z.number().default(20),
      depositPct: z.number().default(35),
      surveyPct: z.number().default(35),
      installDepositPct: z.number().default(20),
      installDay1Pct: z.number().default(50),
      retentionPct: z.number().default(10),
    }).default({}),
  }).default({}),
  quickbooks: z.object({
    mode: z.enum(["none", "oauth", "composio"]).default("none"),
    environment: z.enum(["sandbox", "production"]).default("production"),
    clientId: z.string().default(""),
    clientSecret: z.string().default(""),
    redirectUri: z.string().default(""),
    realmId: z.string().default(""),
    composioApiKey: z.string().default(""),
    composioConnectedAccountId: z.string().default(""),
    postBills: z.boolean().default(false),
    ledgerSince: z.string().default("2025-01-01"),
  }).default({}),
  mail: z.object({
    provider: z.enum(["none", "graph", "imap"]).default("none"),
    graph: z.object({ tenantId: z.string().default(""), clientId: z.string().default(""), clientSecret: z.string().default("") }).default({}),
    imap: z.object({
      host: z.string().default(""), port: z.number().default(993), secure: z.boolean().default(true),
      user: z.string().default(""), password: z.string().default(""),
      smtpHost: z.string().default(""), smtpPort: z.number().default(465), smtpSecure: z.boolean().default(true),
      draftsFolder: z.string().default("Drafts"),
    }).default({}),
    intakeMailboxes: z.array(z.string()).default([]),
    ordersMailboxes: z.array(z.string()).default([]),
    accountsMailbox: z.string().nullable().default(null),
    redirectMailboxes: z.array(z.string()).default([]),
    redirectNotices: z.boolean().default(false),
    liveSendEnabled: z.boolean().default(false),
    partnerDomains: z.array(z.string()).default([]),
    partnerEmails: z.array(z.string()).default([]),
    blockEmails: z.array(z.string()).default([]),
  }).default({}),
  crm: z.object({
    mode: z.enum(["none", "manual", "rest", "webhook", "mcp"]).default("manual"),
    rest: z.object({
      projectsUrl: z.string().default(""),
      projectUrl: z.string().default(""),        // optional: GET one project, {id} placeholder
      noteUrl: z.string().default(""),           // optional: POST a note back, {id} placeholder
      bearerToken: z.string().default(""),
      headers: z.record(z.string()).default({}),
      mapping: z.record(z.string()).default({}), // our field → JSON path in the CRM payload
      rootPath: z.string().default(""),          // JSON path to the array of projects
    }).default({}),
    oauth2: z.object({
      enabled: z.boolean().default(false),
      authorizeUrl: z.string().default(""), tokenUrl: z.string().default(""),
      clientId: z.string().default(""), clientSecret: z.string().default(""), scopes: z.string().default(""),
      grant: z.enum(["authorization_code", "client_credentials"]).default("authorization_code"),
    }).default({}),
    mcp: z.object({ url: z.string().default(""), token: z.string().default(""), listTool: z.string().default("list_projects"), getTool: z.string().default(""), noteTool: z.string().default(""), listArgs: z.record(z.unknown()).default({}) }).default({}),
    webhook: z.object({ secret: z.string().default("") }).default({}),
  }).default({}),
  ai: z.object({
    anthropicApiKey: z.string().default(""),
    openaiApiKey: z.string().default(""),
    extractor: z.enum(["anthropic", "openai"]).default("anthropic"),
    model: z.string().default(""),
  }).default({}),
  notify: z.object({ slackWebhookUrl: z.string().default("") }).default({}),
  intake: z.object({ enabled: z.boolean().default(true), ordersEnabled: z.boolean().default(true) }).default({}),
  setup: z.object({ completedSteps: z.array(z.string()).default([]), completedAt: z.string().nullable().default(null) }).default({}),
}).strict();
export type Connections = z.infer<typeof connectionsSchema>;
export const defaultConnections = (): Connections => connectionsSchema.parse({});

const KEY = "CONFIG#connections";
let cache: { at: number; value: Connections } | null = null;
export function invalidateConnections() { cache = null; }

const list = (v: string | undefined) => (v || "").split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

// Environment overrides (documented in .env.example).
function applyEnv(c: Connections): Connections {
  const e = process.env;
  const out: Connections = JSON.parse(JSON.stringify(c));
  if (e.QBO_CLIENT_ID) { out.quickbooks.clientId = e.QBO_CLIENT_ID; out.quickbooks.mode = "oauth"; }
  if (e.QBO_CLIENT_SECRET) out.quickbooks.clientSecret = e.QBO_CLIENT_SECRET;
  if (e.QBO_REDIRECT_URI) out.quickbooks.redirectUri = e.QBO_REDIRECT_URI;
  if (e.QBO_REALM_ID) out.quickbooks.realmId = e.QBO_REALM_ID;
  if (e.QBO_ENVIRONMENT === "sandbox" || e.QBO_ENVIRONMENT === "production") out.quickbooks.environment = e.QBO_ENVIRONMENT;
  if (e.COMPOSIO_API_KEY) { out.quickbooks.composioApiKey = e.COMPOSIO_API_KEY; }
  if (e.COMPOSIO_QBO_CONNECTED_ACCOUNT_ID) { out.quickbooks.composioConnectedAccountId = e.COMPOSIO_QBO_CONNECTED_ACCOUNT_ID; out.quickbooks.mode = "composio"; }
  if (e.FINANCE_POST_BILLS !== undefined) out.quickbooks.postBills = truthy(e.FINANCE_POST_BILLS);
  if (e.M365_TENANT_ID && e.M365_CLIENT_ID && e.M365_CLIENT_SECRET) { out.mail.provider = "graph"; out.mail.graph = { tenantId: e.M365_TENANT_ID, clientId: e.M365_CLIENT_ID, clientSecret: e.M365_CLIENT_SECRET }; }
  if (e.IMAP_HOST && e.IMAP_USER && e.IMAP_PASSWORD) {
    out.mail.provider = "imap";
    out.mail.imap = { ...out.mail.imap, host: e.IMAP_HOST, port: Number(e.IMAP_PORT || 993), secure: !falsyEnv(e.IMAP_SECURE), user: e.IMAP_USER, password: e.IMAP_PASSWORD, smtpHost: e.SMTP_HOST || out.mail.imap.smtpHost, smtpPort: Number(e.SMTP_PORT || out.mail.imap.smtpPort || 465), smtpSecure: !falsyEnv(e.SMTP_SECURE) };
  }
  if (e.FINANCE_INTAKE_MAILBOXES) out.mail.intakeMailboxes = list(e.FINANCE_INTAKE_MAILBOXES);
  if (e.FINANCE_ORDERS_MAILBOXES) out.mail.ordersMailboxes = list(e.FINANCE_ORDERS_MAILBOXES);
  if (e.FINANCE_ACCOUNTS_MAILBOX) out.mail.accountsMailbox = e.FINANCE_ACCOUNTS_MAILBOX.toLowerCase();
  if (e.FINANCE_LIVE_SEND !== undefined) out.mail.liveSendEnabled = truthy(e.FINANCE_LIVE_SEND);
  if (e.CRM_MODE && ["none", "manual", "rest", "webhook", "mcp"].includes(e.CRM_MODE)) out.crm.mode = e.CRM_MODE as Connections["crm"]["mode"];
  if (e.CRM_REST_PROJECTS_URL) { out.crm.rest.projectsUrl = e.CRM_REST_PROJECTS_URL; if (!e.CRM_MODE) out.crm.mode = "rest"; }
  if (e.CRM_REST_TOKEN) out.crm.rest.bearerToken = e.CRM_REST_TOKEN;
  if (e.CRM_WEBHOOK_SECRET) out.crm.webhook.secret = e.CRM_WEBHOOK_SECRET;
  if (e.CRM_MCP_URL) { out.crm.mcp.url = e.CRM_MCP_URL; if (!e.CRM_MODE) out.crm.mode = "mcp"; }
  if (e.CRM_MCP_TOKEN) out.crm.mcp.token = e.CRM_MCP_TOKEN;
  if (e.ANTHROPIC_API_KEY) out.ai.anthropicApiKey = e.ANTHROPIC_API_KEY;
  if (e.OPENAI_API_KEY) out.ai.openaiApiKey = e.OPENAI_API_KEY;
  if (e.FINANCE_EXTRACTOR === "openai" || e.FINANCE_EXTRACTOR === "anthropic") out.ai.extractor = e.FINANCE_EXTRACTOR;
  if (e.FINANCE_EXTRACT_MODEL) out.ai.model = e.FINANCE_EXTRACT_MODEL;
  if (e.SLACK_WEBHOOK_URL) out.notify.slackWebhookUrl = e.SLACK_WEBHOOK_URL;
  if (e.FINANCE_OWNER_EMAIL) out.company.ownerEmail = e.FINANCE_OWNER_EMAIL.toLowerCase();
  if (e.FINANCE_APPROVER_EMAILS) out.company.approverEmails = list(e.FINANCE_APPROVER_EMAILS);
  if (e.FINANCE_INTERNAL_DOMAINS) out.company.internalDomains = list(e.FINANCE_INTERNAL_DOMAINS);
  if (e.FINANCE_INTAKE_ENABLED !== undefined) out.intake.enabled = truthy(e.FINANCE_INTAKE_ENABLED);
  if (e.FINANCE_ORDERS_INTAKE_ENABLED !== undefined) out.intake.ordersEnabled = truthy(e.FINANCE_ORDERS_INTAKE_ENABLED);
  return out;
}
const falsyEnv = (v: string | undefined) => /^(0|false|no|off)$/i.test((v || "").trim());

export async function storedConnections(): Promise<Connections> {
  if (!appSecretPresent()) return defaultConnections();
  const row = await financeStore().get<{ ciphertext: string }>(company(), KEY).catch(() => null);
  if (!row?.data?.ciphertext) return defaultConnections();
  try { return connectionsSchema.parse(JSON.parse(await appCipher().decrypt(company(), row.data.ciphertext))); }
  catch (e) { console.error("connections: cannot decrypt (APP_SECRET changed?)", e instanceof Error ? e.message : e); return defaultConnections(); }
}

export async function getConnections(opts: { fresh?: boolean } = {}): Promise<Connections> {
  if (!opts.fresh && cache && Date.now() - cache.at < 15_000) return cache.value;
  const value = applyEnv(await storedConnections());
  cache = { at: Date.now(), value };
  return value;
}

// Deep-merge a partial patch into the stored connections (env overrides are
// never written back; the wizard edits only the stored copy).
export async function saveConnections(patch: DeepPartial<Connections>, by = "setup"): Promise<Connections> {
  const stored = await storedConnections();
  const merged = connectionsSchema.parse(deepMerge(stored as unknown as Record<string, unknown>, patch as Record<string, unknown>));
  const ciphertext = await appCipher().encrypt(company(), JSON.stringify(merged));
  await upsert(financeStore(), company(), KEY, () => ({ ciphertext, updatedAt: new Date().toISOString(), updatedBy: by }));
  cache = null;
  return applyEnv(merged);
}
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends Array<unknown> ? T[K] : DeepPartial<T[K]>) : T[K] };
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) out[k] = deepMerge(base[k] as Record<string, unknown>, v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

// Which env vars currently override stored values (so the wizard can say so).
export function envOverrides(): string[] {
  return ["QBO_CLIENT_ID", "QBO_CLIENT_SECRET", "QBO_REDIRECT_URI", "QBO_REALM_ID", "COMPOSIO_API_KEY", "COMPOSIO_QBO_CONNECTED_ACCOUNT_ID", "M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_SECRET", "IMAP_HOST", "IMAP_USER", "IMAP_PASSWORD", "FINANCE_INTAKE_MAILBOXES", "FINANCE_ORDERS_MAILBOXES", "FINANCE_ACCOUNTS_MAILBOX", "CRM_MODE", "CRM_REST_PROJECTS_URL", "CRM_REST_TOKEN", "CRM_WEBHOOK_SECRET", "CRM_MCP_URL", "CRM_MCP_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SLACK_WEBHOOK_URL", "FINANCE_POST_BILLS", "FINANCE_OWNER_EMAIL", "DATABASE_URL"].filter((k) => !!process.env[k]);
}

// Redacted view for the UI: secrets become "••••" + last 4 characters.
export function redactConnections(c: Connections) {
  const mask = (v: string) => (v ? `••••${v.slice(-4)}` : "");
  return {
    ...c,
    quickbooks: { ...c.quickbooks, clientSecret: mask(c.quickbooks.clientSecret), composioApiKey: mask(c.quickbooks.composioApiKey) },
    mail: { ...c.mail, graph: { ...c.mail.graph, clientSecret: mask(c.mail.graph.clientSecret) }, imap: { ...c.mail.imap, password: mask(c.mail.imap.password) } },
    crm: { ...c.crm, rest: { ...c.crm.rest, bearerToken: mask(c.crm.rest.bearerToken) }, oauth2: { ...c.crm.oauth2, clientSecret: mask(c.crm.oauth2.clientSecret) }, mcp: { ...c.crm.mcp, token: mask(c.crm.mcp.token) }, webhook: { secret: mask(c.crm.webhook.secret) } },
    ai: { ...c.ai, anthropicApiKey: mask(c.ai.anthropicApiKey), openaiApiKey: mask(c.ai.openaiApiKey) },
    notify: { slackWebhookUrl: mask(c.notify.slackWebhookUrl) },
  };
}

export function postingEnabledSync(c: Connections) { return !!c.quickbooks.postBills; }
export async function postingEnabled(): Promise<boolean> { return (await getConnections()).quickbooks.postBills; }
