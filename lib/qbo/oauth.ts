// QuickBooks Online OAuth 2.0 with encrypted token custody and a guarded
// self-healing refresh. Ported from a production finance system: the realm
// binds on the first consent, every token use checks the binding, a refresh
// whose outcome was lost is retried on a schedule, and a dead grant ends in a
// clear "reconnect" state rather than a storm of retries.
import { randomBytes, createHmac } from "node:crypto";
import type { Cipher } from "@/lib/core/crypto";
import { equalSecret, FinanceError, hash, invariant } from "@/lib/core/domain";
import { createOnce, lease, type Row, type Store } from "@/lib/core/store";

export interface TokenSource {
  realm(): Promise<string | null>;
  accessToken(opts?: { force?: boolean }): Promise<string>;
}
export type OAuthConfig = { companyId: string; realmId: string; environment: "sandbox" | "production"; clientId: string; clientSecret: string; redirectUri: string };
type Token = { access_token: string; refresh_token: string; expiresAt: number; refreshExpiresAt: number; scope: string; realmId: string; environment: string; clientId: string };
export type TokenRecovery = { attempts: number; lastAt: number; lastError?: string };
export type TokenRow = { ciphertext?: string; status: string; refreshStartedAt?: number; recovery?: TokenRecovery; refreshedAt?: string; recoveredAt?: string; recoveredAfter?: number; disconnectedAt?: string; disconnectedBy?: string };

export const REFRESH_LEASE_MS = 60_000;
export const RECOVERY_MAX_ATTEMPTS = 20;
const RECOVERY_BASE_MS = 5 * 60_000, RECOVERY_MAX_DELAY_MS = 60 * 60_000;
export function recoveryDelay(attempts: number): number { return attempts <= 0 ? 0 : Math.min(RECOVERY_BASE_MS * 2 ** (attempts - 1), RECOVERY_MAX_DELAY_MS); }
const TERMINAL = new Set(["PROVIDER_HTTP_400", "AUTH_EXPIRED", "PERMISSION_DENIED"]);

async function request(url: string, init: RequestInit): Promise<Response> {
  let r: Response;
  try { r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }); }
  catch { throw new FinanceError("PROVIDER_UNREACHABLE", true, 503); }
  if (r.status === 401) throw new FinanceError("AUTH_EXPIRED", false, 401);
  if (r.status === 403) throw new FinanceError("PERMISSION_DENIED", false, 403);
  if (!r.ok) throw new FinanceError(`PROVIDER_HTTP_${r.status}`, r.status === 429 || r.status >= 500, 502);
  return r;
}

export class QboOAuth implements TokenSource {
  constructor(readonly store: Store, readonly cipher: Cipher, readonly config: OAuthConfig, readonly now = () => Date.now()) {}
  async realm(): Promise<string | null> {
    const bound = await this.store.get<{ realmId: string; environment: string }>(this.config.companyId, "CONFIG#qbo-realm");
    if (bound) {
      invariant(bound.data.environment === this.config.environment, "QBO_ENVIRONMENT_MISMATCH");
      invariant(!this.config.realmId || bound.data.realmId === this.config.realmId, "QBO_REALM_MISMATCH");
    }
    return this.config.realmId || bound?.data.realmId || null;
  }
  async begin(principalId: string) {
    const state = randomBytes(32).toString("base64url"), binding = randomBytes(32).toString("base64url");
    await createOnce(this.store, this.config.companyId, `OAUTH_STATE#${hash(state)}`, { principalId, clientId: this.config.clientId, environment: this.config.environment, redirectUri: this.config.redirectUri, bindingHash: hash(binding), expiresAt: this.now() + 600_000, used: false });
    const u = new URL("https://appcenter.intuit.com/connect/oauth2");
    u.search = new URLSearchParams({ client_id: this.config.clientId, response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: this.config.redirectUri, state }).toString();
    return { url: u.toString(), binding };
  }
  async callback(state: string, binding: string, principalId: string, realmId: string, code: string) {
    const release = await lease(this.store, this.config.companyId, "QBO_REFRESH", randomBytes(16).toString("hex"), this.now(), 60_000);
    try { await this.completeCallback(state, binding, principalId, realmId, code); } finally { await release(); }
  }
  private async completeCallback(state: string, binding: string, principalId: string, realmId: string, code: string) {
    invariant(!!realmId, "QBO_REALM_MISSING");
    const bound = await this.realm();
    invariant(!bound || realmId === bound, "QBO_REALM_MISMATCH");
    const row = await this.store.get<{ principalId: string; clientId: string; environment: string; redirectUri: string; bindingHash: string; expiresAt: number; used: boolean }>(this.config.companyId, `OAUTH_STATE#${hash(state)}`);
    invariant(row && !row.data.used && row.data.expiresAt > this.now() && row.data.principalId === principalId && row.data.clientId === this.config.clientId && row.data.environment === this.config.environment && row.data.redirectUri === this.config.redirectUri && equalSecret(row.data.bindingHash, hash(binding)), "OAUTH_STATE_INVALID");
    await this.store.transact(this.config.companyId, [{ key: row.key, expected: row.version, data: { ...row.data, used: true } }]);
    const token = await this.exchange({ grant_type: "authorization_code", code, redirect_uri: this.config.redirectUri }, realmId);
    const existing = await this.store.get(this.config.companyId, "TOKEN#QBO");
    await this.store.transact(this.config.companyId, [
      ...(!bound ? [{ key: "CONFIG#qbo-realm", expected: null, data: { realmId, environment: this.config.environment, boundBy: principalId, boundAt: new Date(this.now()).toISOString() } }] : []),
      { key: "TOKEN#QBO", expected: existing?.version ?? null, data: { ciphertext: await this.cipher.encrypt(this.config.companyId, JSON.stringify(token)), status: "connected" } },
    ]);
  }
  async disconnect(principalId: string) {
    const release = await lease(this.store, this.config.companyId, "QBO_REFRESH", randomBytes(16).toString("hex"), this.now(), 60_000);
    try {
      const row = await this.store.get<TokenRow>(this.config.companyId, "TOKEN#QBO");
      if (!row || row.data.status === "disconnected") return;
      if (row.data.ciphertext) {
        try {
          const token = JSON.parse(await this.cipher.decrypt(this.config.companyId, row.data.ciphertext)) as Token;
          await request("https://developer.api.intuit.com/v2/oauth2/tokens/revoke", { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ token: token.refresh_token }) });
        } catch (e) { console.warn("qbo revoke failed (token dropped anyway):", e instanceof Error ? e.message : e); }
      }
      await this.store.transact(this.config.companyId, [{ key: row.key, expected: row.version, data: { status: "disconnected", disconnectedAt: new Date(this.now()).toISOString(), disconnectedBy: principalId } }]);
    } finally { await release(); }
  }
  private async exchange(body: Record<string, string>, realmId: string): Promise<Token> {
    const response = await request("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(body).toString() });
    const t = await response.json();
    invariant(t.access_token && t.refresh_token && Number.isFinite(t.expires_in), "INVALID_TOKEN_RESPONSE");
    return { access_token: t.access_token, refresh_token: t.refresh_token, expiresAt: this.now() + t.expires_in * 1000, refreshExpiresAt: this.now() + (t.x_refresh_token_expires_in ?? 0) * 1000, scope: t.scope ?? "com.intuit.quickbooks.accounting", realmId, environment: this.config.environment, clientId: this.config.clientId };
  }
  // force = the provider rejected a token we believed valid: refresh now; a
  // refresh completed by someone else in the last 30 s is reused instead.
  async accessToken(opts: { force?: boolean } = {}) {
    const force = !!opts.force, since = this.now();
    const read = async () => {
      const row = await this.store.get<TokenRow>(this.config.companyId, "TOKEN#QBO");
      invariant(row && row.data.ciphertext, "QBO_REAUTH_REQUIRED");
      const status = row.data.status;
      if (status === "refreshing" && this.now() - (row.data.refreshStartedAt ?? 0) < REFRESH_LEASE_MS) throw new FinanceError("QBO_REFRESH_IN_PROGRESS", true, 503);
      const recovering = status === "outcome_unknown" || status === "refreshing";
      invariant(status === "connected" || recovering, "QBO_REAUTH_REQUIRED");
      const t = JSON.parse(await this.cipher.decrypt(this.config.companyId, row.data.ciphertext)) as Token;
      const realm = await this.realm();
      invariant(!!realm && t.realmId === realm && t.environment === this.config.environment && t.clientId === this.config.clientId, "QBO_TOKEN_BINDING");
      return { row, t, recovering };
    };
    let { t, recovering } = await read();
    if (!force && !recovering && t.expiresAt > this.now() + 60_000) return t.access_token;
    const release = await lease(this.store, this.config.companyId, "QBO_REFRESH", randomBytes(16).toString("hex"), this.now(), REFRESH_LEASE_MS);
    try {
      const current = await read();
      t = current.t; recovering = current.recovering;
      const justRefreshed = !!current.row.data.refreshedAt && Date.parse(current.row.data.refreshedAt) > since - 30_000;
      if (!recovering && t.expiresAt > this.now() + 60_000 && (!force || justRefreshed)) return t.access_token;
      const recovery: TokenRecovery = current.row.data.recovery ?? { attempts: 0, lastAt: 0 };
      if (recovering) {
        if (recovery.attempts >= RECOVERY_MAX_ATTEMPTS) { await this.markToken(current.row, "reauth_required", { ...recovery, lastError: "RECOVERY_EXHAUSTED" }); throw new FinanceError("QBO_REAUTH_REQUIRED", false, 401); }
        if (recovery.lastAt && this.now() - recovery.lastAt < recoveryDelay(recovery.attempts)) throw new FinanceError("QBO_REFRESH_PENDING", true, 503);
      }
      if (t.refreshExpiresAt <= this.now()) { await this.markToken(current.row, "reauth_required", { ...recovery, lastError: "REFRESH_TOKEN_EXPIRED" }); throw new FinanceError("QBO_REAUTH_REQUIRED", false, 401); }
      const attempt: TokenRecovery = recovering ? { attempts: recovery.attempts + 1, lastAt: this.now() } : { attempts: 0, lastAt: 0 };
      await this.store.transact(this.config.companyId, [{ key: current.row.key, expected: current.row.version, data: { ...current.row.data, status: "refreshing", refreshStartedAt: this.now(), recovery: attempt } }]);
      try {
        const fresh = await this.exchange({ grant_type: "refresh_token", refresh_token: t.refresh_token }, t.realmId);
        const stamp = new Date(this.now()).toISOString();
        const { recovery: _r, refreshStartedAt: _s, ...rest } = current.row.data;
        await this.store.transact(this.config.companyId, [{ key: current.row.key, expected: current.row.version + 1, data: { ...rest, ciphertext: await this.cipher.encrypt(this.config.companyId, JSON.stringify(fresh)), status: "connected", refreshedAt: stamp, ...(recovering ? { recoveredAt: stamp, recoveredAfter: attempt.attempts } : {}) } }]);
        return fresh.access_token;
      } catch (e) {
        const code = e instanceof FinanceError ? e.code : "REFRESH_FAILED";
        const terminal = TERMINAL.has(code);
        const failed = await this.store.get<TokenRow>(this.config.companyId, "TOKEN#QBO");
        if (failed?.data.status === "refreshing") await this.store.transact(this.config.companyId, [{ key: failed.key, expected: failed.version, data: { ...failed.data, status: terminal ? "reauth_required" : "outcome_unknown", recovery: { attempts: attempt.attempts, lastAt: this.now(), lastError: code } } }]);
        if (terminal) throw new FinanceError("QBO_REAUTH_REQUIRED", false, 401);
        throw new FinanceError("QBO_REFRESH_PENDING", true, 503);
      }
    } finally { await release(); }
  }
  private async markToken(row: Row<TokenRow>, status: string, recovery: TokenRecovery) {
    await this.store.transact(this.config.companyId, [{ key: row.key, expected: row.version, data: { ...row.data, status, recovery } }]);
  }
}

export function verifyQboWebhook(raw: string, signature: string, verifier: string) {
  invariant(!!verifier && equalSecret(createHmac("sha256", verifier).update(raw).digest("base64"), signature), "WEBHOOK_SIGNATURE_INVALID");
}
