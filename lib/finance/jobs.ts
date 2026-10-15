// Scheduled jobs. Each module registers its own job here; the cron route and
// the local scheduler only know names. Keep handlers idempotent.
import { ledgerWarm } from "./jobs-core";
import { syncProjects } from "@/lib/crm/connectors";
import { quickBooksStatus } from "@/lib/qbo/status";

type Handler = (params: Record<string, string>) => Promise<unknown>;
const registry = new Map<string, Handler>();
export function registerJob(name: string, handler: Handler) { registry.set(name, handler); }
export function jobNames() { return [...registry.keys()]; }
export async function runJob(name: string, params: Record<string, string> = {}) {
  await loadJobs();
  const h = registry.get(name);
  if (!h) return { ok: false, error: `unknown job "${name}" — known: ${jobNames().join(", ")}` };
  return h(params);
}

let loaded = false;
export async function loadJobs() {
  if (loaded) return;
  loaded = true;
  registerJob("qbo", async () => { const q = await quickBooksStatus(); const ledger = q.connected ? await ledgerWarm().catch((e) => ({ error: e instanceof Error ? e.message : "LEDGER_FAILED" })) : null; return { quickbooks: { connected: q.connected, tokenStatus: q.tokenStatus, error: q.error ?? null }, ledger }; });
  registerJob("crm-sync", async () => syncProjects({ by: "cron" }));
  // Finance modules register their own jobs (intake, orders, intake-log, reports).
  const { registerModuleJobs } = await import("./module-jobs");
  await registerModuleJobs(registerJob);
}
