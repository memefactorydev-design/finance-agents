// QuickBooks through Composio: Composio owns the OAuth dance and token refresh;
// we read the connected account's credentials and call Intuit's API directly
// with them. The field names Composio uses for OAuth2 state have shifted over
// time, so several are tried; the realm id comes from the connection params or
// from a companyinfo probe when it is not in the payload.
import { FinanceError, invariant } from "@/lib/core/domain";
import type { TokenSource } from "./oauth";

const BASE = "https://backend.composio.dev/api/v3";

export class ComposioQbo implements TokenSource {
  private cached: { token: string; realm: string | null; at: number } | null = null;
  constructor(readonly apiKey: string, readonly connectedAccountId: string) {}
  private async account(): Promise<Record<string, any>> {
    let r: Response;
    try { r = await fetch(`${BASE}/connected_accounts/${encodeURIComponent(this.connectedAccountId)}`, { headers: { "x-api-key": this.apiKey, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(20_000) }); }
    catch { throw new FinanceError("COMPOSIO_UNREACHABLE", true, 503); }
    if (r.status === 401 || r.status === 403) throw new FinanceError("COMPOSIO_KEY_INVALID", false, 401);
    if (r.status === 404) throw new FinanceError("COMPOSIO_ACCOUNT_NOT_FOUND", false, 404);
    if (!r.ok) throw new FinanceError(`COMPOSIO_HTTP_${r.status}`, r.status >= 500, 502);
    return r.json();
  }
  private pick(obj: Record<string, any> | undefined, keys: string[]): string | null {
    for (const k of keys) { const v = obj?.[k]; if (typeof v === "string" && v) return v; }
    return null;
  }
  private async load(force = false) {
    if (!force && this.cached && Date.now() - this.cached.at < 5 * 60_000) return this.cached;
    const a = await this.account();
    const status = String(a.status || a.connectionStatus || "").toUpperCase();
    if (status && status !== "ACTIVE") throw new FinanceError(`COMPOSIO_ACCOUNT_${status}`, false, 428);
    const state = a.state?.val ?? a.connection?.state?.val ?? a.connectionParams ?? a.data ?? {};
    const token = this.pick(state, ["access_token", "accessToken", "token"]);
    invariant(token, "COMPOSIO_NO_ACCESS_TOKEN");
    const realm = this.pick(state, ["realmId", "realm_id", "companyId", "company_id"]) ?? this.pick(a.params, ["realmId", "realm_id", "companyId"]) ?? null;
    this.cached = { token, realm, at: Date.now() };
    return this.cached;
  }
  async realm() { return (await this.load()).realm; }
  async accessToken(opts: { force?: boolean } = {}) {
    if (opts.force) {
      // Ask Composio to refresh, then re-read.
      await fetch(`${BASE}/connected_accounts/${encodeURIComponent(this.connectedAccountId)}/refresh`, { method: "POST", headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" }, body: "{}" }).catch(() => null);
    }
    return (await this.load(opts.force)).token;
  }
}
