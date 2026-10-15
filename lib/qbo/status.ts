// Connection status for the Finance page and the MCP tools. Never throws:
// "connected" is only claimed after a real QuickBooks read succeeds.
import { FinanceError } from "@/lib/core/domain";
import { getConnections } from "@/lib/core/config";
import { company, financeStore } from "@/lib/core/server";
import { qboClient, qboConfigured, tokenSource } from "./client";
import { QboOAuth, REFRESH_LEASE_MS, type TokenRow } from "./oauth";

export interface QuickBooksRecovery { attempts: number; lastAt: string | null; lastError: string | null; recoveredAt: string | null }
export interface QuickBooksStatus {
  mode: "none" | "oauth" | "composio";
  configured: boolean;
  environment: string;
  realm: string | null;
  companyName: string | null;
  connected: boolean;
  tokenStatus: string | null;
  posting: boolean;
  recovery?: QuickBooksRecovery | null;
  error?: string;
}

export async function quickBooksStatus(): Promise<QuickBooksStatus> {
  const cfg = await getConnections();
  const base: QuickBooksStatus = { mode: cfg.quickbooks.mode, configured: qboConfigured(cfg), environment: cfg.quickbooks.environment, realm: cfg.quickbooks.realmId || null, companyName: null, connected: false, tokenStatus: null, posting: cfg.quickbooks.postBills };
  if (!base.configured) return base;
  try {
    const src = await tokenSource(cfg);
    if (src instanceof QboOAuth) {
      const token = await financeStore().get<TokenRow>(company(), "TOKEN#QBO");
      const status = token?.data.status ?? null;
      base.tokenStatus = status;
      base.recovery = describeRecovery(token?.data);
      const stale = status === "refreshing" && Date.now() - (token?.data.refreshStartedAt ?? 0) >= REFRESH_LEASE_MS;
      const healable = status === "connected" || status === "outcome_unknown" || stale;
      if (!healable) return base;
    }
    const api = await qboClient();
    const info = await api.get(`/companyinfo/${encodeURIComponent(api.realm)}`);
    base.realm = api.realm;
    base.companyName = info?.CompanyInfo?.CompanyName || null;
    base.connected = true;
    base.tokenStatus = "connected";
    const after = await financeStore().get<TokenRow>(company(), "TOKEN#QBO").catch(() => null);
    if (after) base.recovery = describeRecovery(after.data);
  } catch (e) {
    const code = e instanceof FinanceError ? e.code : "QBO_TOKEN_CHECK_FAILED";
    base.connected = code === "QBO_REFRESH_IN_PROGRESS" || code === "LEASE_BUSY";
    base.error = code;
    const after = await financeStore().get<TokenRow>(company(), "TOKEN#QBO").catch(() => null);
    if (after) { base.tokenStatus = after.data.status; base.recovery = describeRecovery(after.data); }
  }
  return base;
}
function describeRecovery(row: TokenRow | undefined): QuickBooksRecovery | null {
  if (!row?.recovery && !row?.recoveredAt) return null;
  return { attempts: row.recovery?.attempts ?? 0, lastAt: row.recovery?.lastAt ? new Date(row.recovery.lastAt).toISOString() : null, lastError: row.recovery?.lastError ?? null, recoveredAt: row.recoveredAt ?? null };
}
