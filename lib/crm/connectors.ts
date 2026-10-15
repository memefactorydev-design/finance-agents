// CRM connectors. Every connector produces Project records in our shape and
// upserts them into the store; the finance system only ever reads the store.
//   manual  — projects are created and edited in this app
//   rest    — GET a JSON endpoint (bearer / headers / OAuth2) on a schedule;
//             a field mapping turns the CRM's payload into our Project shape
//   webhook — the CRM POSTs project upserts to /api/webhooks/crm (HMAC secret)
//   mcp     — call a tool on the CRM's MCP server that returns projects
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getConnections, type Connections } from "@/lib/core/config";
import { FinanceError, invariant, nowIso } from "@/lib/core/domain";
import { company, financeStore } from "@/lib/core/server";
import { upsert } from "@/lib/core/store";
import { normaliseIncomingProject, type IncomingProject } from "./mapping";
import { upsertProject } from "./projects";

export type CrmMode = Connections["crm"]["mode"];

export interface SyncResult { mode: CrmMode; ok: boolean; fetched: number; upserted: number; errors: string[]; ms: number; at: string }

// ------------------------------------------------------------ OAuth2 token
// For REST CRMs that need OAuth2: client_credentials runs unattended;
// authorization_code stores the refresh token after the one-time consent
// (/api/oauth/crm/connect → callback). The access token is cached in the store.
interface CrmTokenRow { accessToken: string; refreshToken?: string | null; expiresAt: number }
export async function crmAccessToken(cfg: Connections): Promise<string | null> {
  const o = cfg.crm.oauth2;
  if (!o.enabled) return cfg.crm.rest.bearerToken || null;
  const store = financeStore();
  const row = await store.get<CrmTokenRow>(company(), "TOKEN#CRM");
  if (row?.data.accessToken && row.data.expiresAt > Date.now() + 60_000) return row.data.accessToken;
  const body = o.grant === "client_credentials"
    ? { grant_type: "client_credentials", client_id: o.clientId, client_secret: o.clientSecret, ...(o.scopes ? { scope: o.scopes } : {}) }
    : row?.data.refreshToken ? { grant_type: "refresh_token", refresh_token: row.data.refreshToken, client_id: o.clientId, client_secret: o.clientSecret } : null;
  if (!body) throw new FinanceError("CRM_OAUTH_CONSENT_REQUIRED", false, 428);
  const r = await fetch(o.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(body as Record<string, string>).toString() });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw new FinanceError(`CRM_OAUTH_${r.status}: ${t.error_description || t.error || ""}`.trim(), r.status >= 500, 502);
  await upsert<CrmTokenRow>(store, company(), "TOKEN#CRM", (cur) => ({ accessToken: t.access_token, refreshToken: t.refresh_token || cur?.refreshToken || null, expiresAt: Date.now() + Number(t.expires_in || 3600) * 1000 }));
  return t.access_token;
}
export async function storeCrmTokens(t: { access_token: string; refresh_token?: string; expires_in?: number }) {
  await upsert<CrmTokenRow>(financeStore(), company(), "TOKEN#CRM", (cur) => ({ accessToken: t.access_token, refreshToken: t.refresh_token || cur?.refreshToken || null, expiresAt: Date.now() + Number(t.expires_in || 3600) * 1000 }));
}

// JSON path helper: "data.items" / "customer.name" / "orders[0].ref"
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean).reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

// ----------------------------------------------------------------- REST
export async function fetchRestProjects(cfg: Connections): Promise<IncomingProject[]> {
  const rest = cfg.crm.rest;
  invariant(rest.projectsUrl, "CRM_REST_URL_MISSING");
  const token = await crmAccessToken(cfg);
  const r = await fetch(rest.projectsUrl, { headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...rest.headers }, cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new FinanceError(`CRM_REST_${r.status}`, r.status >= 500, 502);
  const json = await r.json();
  const root = getPath(json, rest.rootPath) ?? json;
  const list = Array.isArray(root) ? root : Array.isArray((root as any)?.projects) ? (root as any).projects : Array.isArray((root as any)?.data) ? (root as any).data : Array.isArray((root as any)?.items) ? (root as any).items : [];
  return list.map((raw: unknown) => normaliseIncomingProject(raw, rest.mapping));
}

// ------------------------------------------------------------------ MCP
export async function mcpCall(cfg: Connections, name: string, args: Record<string, unknown>): Promise<unknown> {
  const m = cfg.crm.mcp;
  invariant(m.url, "CRM_MCP_URL_MISSING");
  const client = new Client({ name: "finance-agents", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(m.url), { requestInit: { headers: m.token ? { Authorization: `Bearer ${m.token}` } : {} } });
  try {
    await client.connect(transport);
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text;
    if (r.isError) throw new FinanceError(`CRM_MCP_TOOL_ERROR: ${(text || "").slice(0, 200)}`, false, 502);
    return (r as { structuredContent?: unknown }).structuredContent ?? (text ? safeJson(text) : null);
  } finally { await client.close().catch(() => {}); }
}
export async function mcpListTools(cfg: Connections): Promise<string[]> {
  const m = cfg.crm.mcp;
  invariant(m.url, "CRM_MCP_URL_MISSING");
  const client = new Client({ name: "finance-agents-probe", version: "0.1.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(m.url), { requestInit: { headers: m.token ? { Authorization: `Bearer ${m.token}` } : {} } }));
    return (await client.listTools()).tools.map((t) => t.name);
  } finally { await client.close().catch(() => {}); }
}
const safeJson = (t: string) => { try { return JSON.parse(t); } catch { return t; } };
export async function fetchMcpProjects(cfg: Connections): Promise<IncomingProject[]> {
  const result = await mcpCall(cfg, cfg.crm.mcp.listTool || "list_projects", cfg.crm.mcp.listArgs || {});
  const root = getPath(result, cfg.crm.rest.rootPath) ?? result;
  const list = Array.isArray(root) ? root : Array.isArray((root as any)?.projects) ? (root as any).projects : Array.isArray((root as any)?.leads) ? (root as any).leads : Array.isArray((root as any)?.data) ? (root as any).data : Array.isArray((root as any)?.items) ? (root as any).items : [];
  return list.map((raw: unknown) => normaliseIncomingProject(raw, cfg.crm.rest.mapping));
}

// ------------------------------------------------------------------ sync
export async function syncProjects(opts: { by?: string } = {}): Promise<SyncResult> {
  const t0 = Date.now();
  const cfg = await getConnections();
  const result: SyncResult = { mode: cfg.crm.mode, ok: true, fetched: 0, upserted: 0, errors: [], ms: 0, at: nowIso() };
  try {
    let incoming: IncomingProject[] = [];
    if (cfg.crm.mode === "rest") incoming = await fetchRestProjects(cfg);
    else if (cfg.crm.mode === "mcp") incoming = await fetchMcpProjects(cfg);
    else { result.ms = Date.now() - t0; await recordSync(result); return result; } // manual / webhook / none: nothing to pull
    result.fetched = incoming.length;
    for (const p of incoming) {
      try { await upsertProject({ ...p, source: { kind: cfg.crm.mode as "rest" | "mcp", externalId: p.id || null, syncedAt: nowIso() } }, opts.by || "crm-sync"); result.upserted += 1; }
      catch (e) { result.errors.push(`${p.id || p.lastName}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  } catch (e) { result.ok = false; result.errors.push(e instanceof Error ? e.message : String(e)); }
  result.ms = Date.now() - t0;
  await recordSync(result);
  return result;
}
async function recordSync(r: SyncResult) { await upsert(financeStore(), company(), "HEALTH#CRM", () => r).catch(() => {}); }
export async function lastSync(): Promise<SyncResult | null> { return (await financeStore().get<SyncResult>(company(), "HEALTH#CRM"))?.data ?? null; }

// Write-back (best effort): notes to the CRM when a URL / tool is configured.
export async function connectorWriteback(kind: "note", payload: { projectId: string; text: string; by: string }): Promise<void> {
  const cfg = await getConnections();
  if (cfg.crm.mode === "rest" && cfg.crm.rest.noteUrl) {
    const token = await crmAccessToken(cfg).catch(() => null);
    await fetch(cfg.crm.rest.noteUrl.replace("{id}", encodeURIComponent(payload.projectId)), { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...cfg.crm.rest.headers }, body: JSON.stringify({ projectId: payload.projectId, text: payload.text, by: payload.by, source: "finance-agents" }) });
  } else if (cfg.crm.mode === "mcp" && cfg.crm.mcp.noteTool) {
    await mcpCall(cfg, cfg.crm.mcp.noteTool, { projectId: payload.projectId, leadId: payload.projectId, text: payload.text, note: payload.text, by: payload.by });
  }
  void kind;
}
