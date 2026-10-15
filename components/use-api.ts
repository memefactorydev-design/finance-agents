"use client";

// Small client-side data layer: a fetch wrapper that turns the API error
// envelope ({ error: { code, message } } or { error: "CODE" }) into an Error,
// a one-call hook for GET endpoints, and a company context (name, currency,
// finance defaults, signed-in user) shared by every page.
import * as React from "react";
import type { FinanceDefaults } from "@/lib/crm/schedule";

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

export function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error: unknown }).error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object") { const o = e as { message?: string; code?: string }; return o.message || o.code || `HTTP ${status}`; }
  }
  return `HTTP ${status}`;
}

export async function api<T = unknown>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(headers || {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const e = body && typeof body === "object" && "error" in body ? (body as { error: unknown }).error : null;
    const code = e && typeof e === "object" ? (e as { code?: string }).code : typeof e === "string" ? e : undefined;
    throw new ApiError(errorMessage(body, res.status), res.status, code);
  }
  return body as T;
}

export interface ApiState<T> { data: T | null; error: string | null; loading: boolean; reload: () => Promise<void>; setData: React.Dispatch<React.SetStateAction<T | null>> }

// GET `url` once (and again when `url` or `deps` change). `url: null` disables.
export function useApi<T>(url: string | null, deps: unknown[] = []): ApiState<T> {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(!!url);
  const seq = React.useRef(0);
  const reload = React.useCallback(async () => {
    if (!url) { setLoading(false); return; }
    const n = ++seq.current;
    setLoading(true); setError(null);
    try { const d = await api<T>(url); if (n === seq.current) setData(d); }
    catch (e) { if (n === seq.current) setError(e instanceof Error ? e.message : "Failed"); }
    finally { if (n === seq.current) setLoading(false); }
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { reload(); }, [reload, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, reload, setData };
}

// ------------------------------------------------------------- company
export interface SessionUser { id: string; name: string; role: "admin" | "agent" }
export interface CompanyInfo {
  loaded: boolean;
  name: string;
  currency: string;
  timezone: string;
  channelName: string;
  defaults: FinanceDefaults;
  user: SessionUser | null;
  reload: () => Promise<void>;
}
export const FINANCE_DEFAULTS: FinanceDefaults = { defaultVatRate: 20, depositPct: 35, surveyPct: 35, installDepositPct: 20, installDay1Pct: 50, retentionPct: 10 };
const EMPTY: CompanyInfo = { loaded: false, name: "", currency: "GBP", timezone: "Europe/London", channelName: "internal-finance", defaults: FINANCE_DEFAULTS, user: null, reload: async () => {} };
const CompanyContext = React.createContext<CompanyInfo>(EMPTY);

interface SetupPayload { state?: { ownerSet?: boolean }; connections?: { company?: { name?: string; currency?: string; timezone?: string; channelName?: string; finance?: Partial<FinanceDefaults> } } | null; user?: SessionUser | null }

export function CompanyProvider({ children }: { children: React.ReactNode }) {
  const [info, setInfo] = React.useState<CompanyInfo>(EMPTY);
  const load = React.useCallback(async () => {
    try {
      const d = await api<SetupPayload>("/api/setup");
      const c = d.connections?.company;
      setInfo({ loaded: true, name: c?.name || "", currency: c?.currency || "GBP", timezone: c?.timezone || "Europe/London", channelName: c?.channelName || "internal-finance", defaults: { ...FINANCE_DEFAULTS, ...(c?.finance || {}) }, user: d.user || null, reload: load });
    } catch { setInfo({ ...EMPTY, loaded: true, reload: load }); }
  }, []);
  React.useEffect(() => { load(); }, [load]);
  return React.createElement(CompanyContext.Provider, { value: info }, children);
}
export function useCompany() { return React.useContext(CompanyContext); }

// Currency-aware formatters. Money figures are the only place the `money`
// colour token is used; these helpers just format.
export function useMoney() {
  const { currency } = useCompany();
  return React.useMemo(() => {
    const fmt = (fraction: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: fraction, maximumFractionDigits: fraction });
    const f0 = fmt(0), f2 = fmt(2);
    return {
      currency,
      money: (v: number | null | undefined) => f0.format(v || 0),
      money2: (v: number | null | undefined) => f2.format(v || 0),
      symbol: f0.formatToParts(0).find((p) => p.type === "currency")?.value || currency,
    };
  }, [currency]);
}

// Clipboard with a graceful fallback for non-secure contexts.
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); return true; } catch { return false; }
  }
}
