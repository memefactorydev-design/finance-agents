// Supplier invoices actually received per project, straight from the
// QuickBooks ledger: Bills (+), Vendor Credits (−) and expenses/Purchases (+)
// whose lines carry a Class (class = the customer / project).
//
// This is the cost basis of the Completion P&L: Sales = the sales costing,
// Order = what was ordered, Supplier = what the suppliers acknowledged,
// Completion = what the suppliers actually invoiced. Until every supplier on a
// project has invoiced, Completion stays "awaiting".
//
// One ledger read covers every project (three paged queries), so it is cached
// in memory for 5 minutes and in the finance store for an hour; the `qbo`
// cron job keeps the store copy warm.
import { r2 } from "@/lib/core/domain";
import { getConnections } from "@/lib/core/config";
import { company, financeStore } from "@/lib/core/server";
import { normName } from "@/lib/core/text";
import { onQboWrite, qboClient, tokenNear } from "@/lib/qbo/client";
import { registerCache } from "./caches";

export interface LedgerVendorCost { vendor: string; net: number; docs: number }
export interface ClassLedgerCosts {
  classId: string;
  className: string;
  net: number;                 // Σ line amounts (net of VAT) across bills, credits and purchases
  docs: number;                // distinct documents touching the class
  vendors: LedgerVendorCost[];
  firstTxnDate: string | null;
  lastTxnDate: string | null;
}
export interface LedgerCostsByClass {
  since: string;
  byClass: Record<string, ClassLedgerCosts>;
  docs: number;
  fetchedAt: string;
  source: string;
}

// What one project gets out of the ledger (see projectLedgerCosts).
export interface ProjectLedger {
  classId: string;
  className: string;
  net: number;
  docs: number;
  vendors: LedgerVendorCost[];
  lastTxnDate: string | null;
  ambiguous?: string[];        // several classes matched the customer — nothing summed
}

const STORE_KEY = "LEDGER#costs-by-class";
let mem: { at: number; data: LedgerCostsByClass } | null = null;
// A QuickBooks write (a bill posted) makes the stored copy stale too: the next
// read goes back to QuickBooks once, then the normal caching resumes.
let forceFresh = false;
export function invalidateLedgerCache() { mem = null; forceFresh = true; }
registerCache(invalidateLedgerCache);
onQboWrite(invalidateLedgerCache);

export async function ledgerCostsByClass(opts: { fresh?: boolean; maxAgeMs?: number } = {}): Promise<LedgerCostsByClass> {
  const maxAge = opts.maxAgeMs ?? 60 * 60_000;
  const fresh = opts.fresh || forceFresh;
  if (!fresh && mem && Date.now() - mem.at < 5 * 60_000 && Date.now() - Date.parse(mem.data.fetchedAt) < maxAge) return mem.data;
  const store = financeStore();
  const c = company();
  const existing = await store.get<LedgerCostsByClass>(c, STORE_KEY).catch(() => null);
  if (!fresh && existing?.data?.fetchedAt && Date.now() - Date.parse(existing.data.fetchedAt) < maxAge) {
    mem = { at: Date.now(), data: existing.data };
    return existing.data;
  }
  const data = await readLedger();
  forceFresh = false;
  mem = { at: Date.now(), data };
  await store.transact(c, [{ key: STORE_KEY, expected: existing?.version ?? null, data }]).catch(() => {});
  return data;
}

type Agg = ClassLedgerCosts & { vendorMap: Map<string, LedgerVendorCost>; docIds: Set<string> };

async function readLedger(): Promise<LedgerCostsByClass> {
  const cfg = await getConnections();
  const since = cfg.quickbooks.ledgerSince || "2025-01-01";
  const api = await qboClient();
  const where = `TxnDate >= '${since}'`;
  const [bills, credits, purchases] = await Promise.all([
    api.query("Bill", where),
    api.query("VendorCredit", where),
    api.query("Purchase", where),
  ]);
  return aggregateLedger({ bills, credits, purchases }, since);
}

// Pure aggregation (exported for tests): a credit, or a Purchase flagged as a
// credit, reduces the class cost; everything else adds to it.
export function aggregateLedger(docs: { bills: any[]; credits: any[]; purchases: any[] }, since: string): LedgerCostsByClass {
  const agg = new Map<string, Agg>();
  let count = 0;
  const add = (kind: "Bill" | "VendorCredit" | "Purchase", d: any) => {
    const sign = kind === "VendorCredit" || (kind === "Purchase" && d.Credit === true) ? -1 : 1;
    const vendor: string = d.VendorRef?.name || d.EntityRef?.name || "Unknown payee";
    const txnDate: string | null = d.TxnDate || null;
    const touched = new Set<string>();
    for (const line of d.Line || []) {
      const detail = line.AccountBasedExpenseLineDetail || line.ItemBasedExpenseLineDetail;
      const cls = detail?.ClassRef;
      if (!cls?.value) continue;
      const amount = Number(line.Amount || 0) * sign;
      const id = String(cls.value);
      let a = agg.get(id);
      if (!a) { a = { classId: id, className: cls.name || id, net: 0, docs: 0, vendors: [], firstTxnDate: null, lastTxnDate: null, vendorMap: new Map(), docIds: new Set() }; agg.set(id, a); }
      a.net += amount;
      if (cls.name && a.className === id) a.className = cls.name;
      const v = a.vendorMap.get(vendor) || { vendor, net: 0, docs: 0 };
      v.net += amount;
      if (!touched.has(`${id}|${vendor}`)) { v.docs += 1; touched.add(`${id}|${vendor}`); }
      a.vendorMap.set(vendor, v);
      if (!a.docIds.has(`${kind}#${d.Id}`)) { a.docIds.add(`${kind}#${d.Id}`); a.docs += 1; }
      if (txnDate) {
        if (!a.firstTxnDate || txnDate < a.firstTxnDate) a.firstTxnDate = txnDate;
        if (!a.lastTxnDate || txnDate > a.lastTxnDate) a.lastTxnDate = txnDate;
      }
    }
    count += 1;
  };
  for (const b of docs.bills) add("Bill", b);
  for (const c of docs.credits) add("VendorCredit", c);
  for (const p of docs.purchases) add("Purchase", p);
  const byClass: Record<string, ClassLedgerCosts> = {};
  for (const a of agg.values()) {
    byClass[a.classId] = {
      classId: a.classId, className: a.className, net: r2(a.net), docs: a.docs,
      vendors: Array.from(a.vendorMap.values()).map((v) => ({ ...v, net: r2(v.net) })).sort((x, y) => y.net - x.net),
      firstTxnDate: a.firstTxnDate, lastTxnDate: a.lastTxnDate,
    };
  }
  return { since, byClass, docs: count, fetchedAt: new Date().toISOString(), source: "QuickBooks Bills + Vendor Credits + Purchases with a class, net of VAT" };
}

// ---------------------------------------------------------------- matching
const tokens = (s: string) => normName(s).split(" ").filter((t) => t.length > 2 && t !== "and" && t !== "mr" && t !== "mrs");

// Project → QuickBooks class. Exact name first, then every customer token
// contained in the class name, then near-miss spellings (one edit per token).
// Several candidates = ambiguous: nothing is summed and the caller shows the names.
export function matchClasses(customerName: string, classes: { classId: string; className: string }[]): { classId: string; className: string }[] {
  const n = normName(customerName);
  if (!n) return [];
  const exact = classes.filter((c) => normName(c.className) === n);
  if (exact.length) return exact;
  const parts = tokens(customerName);
  if (parts.length < 1 || (parts.length === 1 && parts[0].length < 4)) return [];
  const contained = classes.filter((c) => { const cn = ` ${normName(c.className)} `; return parts.every((p) => cn.includes(` ${p} `)); });
  if (contained.length) return contained;
  if (parts.length < 2) return [];
  return classes.filter((c) => { const ct = tokens(c.className); return parts.every((p) => ct.some((t) => tokenNear(p, t))); });
}

export function projectLedgerCosts(project: { firstName?: string | null; lastName?: string | null }, data: LedgerCostsByClass | null | undefined): ProjectLedger | null | undefined {
  if (!data) return undefined;
  const name = `${project.firstName || ""} ${project.lastName || ""}`.trim();
  const hits = matchClasses(name, Object.values(data.byClass));
  if (!hits.length) return null;
  if (hits.length > 1) {
    const first = data.byClass[hits[0].classId];
    return { classId: "", className: "", net: 0, docs: 0, vendors: [], lastTxnDate: first?.lastTxnDate ?? null, ambiguous: hits.map((h) => h.className) };
  }
  const c = data.byClass[hits[0].classId];
  return { classId: c.classId, className: c.className, net: c.net, docs: c.docs, vendors: c.vendors, lastTxnDate: c.lastTxnDate };
}

// Supplier names on purchase orders vs payee names on the ledger lines.
// `aliases` maps a normalised name to its canonical vendor (built from the
// supplier playbook: a brand name on the order and the legal entity on the
// bill still match).
export type SupplierAliasIndex = Map<string, string>;
export function supplierAliasIndex(profiles: { vendorName: string; aliases?: string[] | null }[]): SupplierAliasIndex {
  const idx: SupplierAliasIndex = new Map();
  for (const p of profiles) {
    const canonical = normName(p.vendorName);
    if (!canonical) continue;
    idx.set(canonical, canonical);
    for (const a of p.aliases || []) { const n = normName(a); if (n) idx.set(n, canonical); }
  }
  return idx;
}
export function vendorMatches(orderSupplier: string, ledgerVendor: string, aliases?: SupplierAliasIndex): boolean {
  if (aliases) {
    const ca = aliases.get(normName(orderSupplier)), cb = aliases.get(normName(ledgerVendor));
    if (ca && cb) return ca === cb;
  }
  const a = tokens(orderSupplier), b = tokens(ledgerVendor);
  if (!a.length || !b.length) return normName(orderSupplier) === normName(ledgerVendor);
  const shorter = a.length <= b.length ? a : b, longer = shorter === a ? b : a;
  return shorter.every((p) => longer.some((t) => tokenNear(p, t)));
}
