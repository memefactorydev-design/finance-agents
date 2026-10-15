// Owner login (password → signed cookie) and API keys for agents / MCP.
// Single-owner app: the person who ran setup is the admin. Extra API keys can
// be minted for agents with the "agent" role (same reads, writes attributed).
import { createHmac } from "node:crypto";
import { cookies } from "next/headers";
import { appSecret, appSecretPresent, hashPassword, randomToken, verifyPassword } from "./crypto";
import { bytesHash, equalSecret, FinanceError, invariant } from "./domain";
import { company, financeStore } from "./server";
import { all, upsert } from "./store";

export const SESSION_COOKIE = "fa_session";
const SESSION_DAYS = 30;

export interface Principal { id: string; name: string; role: "admin" | "agent"; kind: "human" | "api_key"; }

// ---------------------------------------------------------------- owner
interface OwnerRow { email: string; name: string; passwordHash: string; createdAt: string }
export async function owner(): Promise<OwnerRow | null> {
  return (await financeStore().get<OwnerRow>(company(), "AUTH#owner"))?.data ?? null;
}
export async function setOwner(input: { email: string; name: string; password: string }): Promise<void> {
  invariant(input.password.length >= 8, "PASSWORD_TOO_SHORT");
  await upsert<OwnerRow>(financeStore(), company(), "AUTH#owner", (cur) => ({ email: input.email.toLowerCase(), name: input.name, passwordHash: hashPassword(input.password), createdAt: cur?.createdAt || new Date().toISOString() }));
}
export async function verifyOwner(email: string, password: string): Promise<OwnerRow | null> {
  const o = await owner();
  if (!o || o.email !== email.toLowerCase()) return null;
  return verifyPassword(password, o.passwordHash) ? o : null;
}

// -------------------------------------------------------------- sessions
const sig = (payload: string) => createHmac("sha256", `finance-agents:session:${appSecret()}`).update(payload).digest("base64url");
export function sessionToken(email: string): string {
  const payload = Buffer.from(JSON.stringify({ e: email.toLowerCase(), x: Date.now() + SESSION_DAYS * 86_400_000, n: randomToken(8) })).toString("base64url");
  return `${payload}.${sig(payload)}`;
}
export function readSessionToken(token: string | undefined | null): { email: string } | null {
  if (!token || !appSecretPresent()) return null;
  const [payload, s] = token.split(".");
  if (!payload || !s || !equalSecret(sig(payload), s)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { e: string; x: number };
    return data.x > Date.now() ? { email: data.e } : null;
  } catch { return null; }
}
export async function currentUser(): Promise<Principal | null> {
  const s = readSessionToken(cookies().get(SESSION_COOKIE)?.value);
  if (!s) return null;
  const o = await owner();
  if (!o || o.email !== s.email) return null;
  return { id: o.email, name: o.name, role: "admin", kind: "human" };
}
export async function requireUser(): Promise<Principal> {
  const u = await currentUser();
  if (!u) throw new FinanceError("UNAUTHENTICATED", false, 401);
  return u;
}

// --------------------------------------------------------------- API keys
export interface ApiKeyRow { id: string; name: string; role: "admin" | "agent"; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; prefix: string }
export async function createApiKey(name: string, role: "admin" | "agent" = "admin"): Promise<{ key: string; row: ApiKeyRow }> {
  const key = `fa_${randomToken(24)}`;
  const id = bytesHash(key);
  const row: ApiKeyRow = { id, name, role, createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null, prefix: key.slice(0, 7) };
  await financeStore().transact(company(), [{ key: `APIKEY#${id}`, expected: null, data: row }]);
  return { key, row };
}
export async function listApiKeys(): Promise<ApiKeyRow[]> {
  return (await all<ApiKeyRow>(financeStore(), company(), "APIKEY#")).map((r) => r.data).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function revokeApiKey(id: string): Promise<void> {
  await upsert<ApiKeyRow>(financeStore(), company(), `APIKEY#${id}`, (cur) => { invariant(cur, "API_KEY_NOT_FOUND"); return { ...cur, revokedAt: new Date().toISOString() }; });
}
export async function verifyApiKey(key: string | null | undefined): Promise<Principal | null> {
  const k = (key || "").trim().replace(/^Bearer\s+/i, "");
  if (!k.startsWith("fa_")) return null;
  const row = await financeStore().get<ApiKeyRow>(company(), `APIKEY#${bytesHash(k)}`);
  if (!row || row.data.revokedAt) return null;
  // Touch lastUsedAt at most once a minute (best effort, never blocks a call).
  if (!row.data.lastUsedAt || Date.now() - Date.parse(row.data.lastUsedAt) > 60_000)
    financeStore().transact(company(), [{ key: row.key, expected: row.version, data: { ...row.data, lastUsedAt: new Date().toISOString() } }]).catch(() => {});
  return { id: `apikey:${row.data.name}`, name: row.data.name, role: row.data.role, kind: "api_key" };
}

// Session cookie OR API key (Authorization: Bearer fa_… / x-api-key).
export async function principalFromRequest(request: Request): Promise<Principal | null> {
  const viaKey = await verifyApiKey(request.headers.get("authorization") || request.headers.get("x-api-key"));
  if (viaKey) return viaKey;
  return currentUser();
}
export async function requirePrincipal(request: Request): Promise<Principal> {
  const p = await principalFromRequest(request);
  if (!p) throw new FinanceError("UNAUTHENTICATED", false, 401);
  return p;
}
export function requireAdmin(p: Principal) { if (p.role !== "admin") throw new FinanceError("FORBIDDEN", false, 403); }
export const actorName = (p: Principal) => (p.kind === "api_key" ? `${p.name} (agent)` : p.name || p.id);
