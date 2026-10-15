// Server wiring: the one company this install serves, its store and evidence
// backend, and the error → HTTP response mapping every route uses.
import { join } from "node:path";
import { FinanceError } from "./domain";
import { FileStore, PostgresStore, type Store } from "./store";
import { FileEvidence, PostgresEvidence, type EvidenceAdapter } from "./evidence";

export const DATA_DIR = process.env.FINANCE_DATA_DIR || join(process.cwd(), "data");

// Single-tenant: every row is keyed under this company id.
export const company = () => process.env.FINANCE_COMPANY_ID || "default";

let storeCache: Store | null = null;
export function financeStore(): Store {
  if (storeCache) return storeCache;
  storeCache = process.env.DATABASE_URL ? new PostgresStore(process.env.DATABASE_URL) : new FileStore(join(DATA_DIR, "store.json"));
  return storeCache;
}
export function setStoreForTests(s: Store | null) { storeCache = s; }

let evidenceCache: EvidenceAdapter | null = null;
export function evidence(): EvidenceAdapter {
  if (evidenceCache) return evidenceCache;
  evidenceCache = process.env.DATABASE_URL ? new PostgresEvidence(process.env.DATABASE_URL) : new FileEvidence(join(DATA_DIR, "evidence"));
  return evidenceCache;
}

export function financeError(e: unknown) {
  const error = e instanceof FinanceError ? e : new FinanceError(e instanceof Error ? e.message.slice(0, 200) : "FINANCE_UNAVAILABLE", false, 500);
  if (!(e instanceof FinanceError)) console.error(e);
  return Response.json({ error: { code: error.code, message: error.message, retryable: error.retryable } }, { status: error.status, headers: { "Cache-Control": "no-store" } });
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new FinanceError("CSRF_ORIGIN", false, 403);
}
