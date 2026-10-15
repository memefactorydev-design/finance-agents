// QuickBooks Vendor Balance Detail = every unpaid supplier bill / credit by
// vendor with its due date — the supplier side of the cashflow. Read-only;
// cached for five minutes per server instance and dropped on any QuickBooks
// write. Disputed items (the dispute register, plus anything the supplier-terms
// cutoff put under review) are reported but never counted as cash due.
import { FinanceError, r2 } from "@/lib/core/domain";
import { company, financeStore } from "@/lib/core/server";
import { localDate, shiftDays } from "@/lib/core/text";
import { onQboWrite, qboClient } from "@/lib/qbo/client";
import { registerCache } from "./caches";
import { activeDisputedBillIds } from "./suppliers";

// Owner-declared disputed supplier bills (written by applySupplierTerms).
export interface DisputedBillsConfig {
  cutoff: string;
  reason: string;
  setAt: string;
  setBy: string;
  ids: string[];
  items: { id: string; vendor: string; vendorId: string | null; date: string; num: string | null; balance: number }[];
}
export const DISPUTED_BILLS_KEY = "CONFIG#disputed-bills";
export async function disputedBillsConfig(): Promise<DisputedBillsConfig | null> {
  try { return (await financeStore().get<DisputedBillsConfig>(company(), DISPUTED_BILLS_KEY))?.data ?? null; } catch { return null; }
}

export interface VendorBalanceItem {
  id: string | null;         // QuickBooks transaction id
  date: string | null;       // transaction date (YYYY-MM-DD)
  type: string;              // Bill, Vendor Credit, Bill Payment…
  num: string | null;        // document / bill number
  dueDate: string | null;
  amount: number;            // original amount
  openBalance: number;       // still unpaid (negative = credit)
  daysOverdue: number | null;
  disputed: boolean;         // in the dispute register / before the cutoff — excluded from cash buckets
}
export interface VendorBalance {
  vendor: string;
  vendorId: string | null;
  open: number;              // net of unapplied credits/payments
  bills: number;             // positive open items only
  unapplied: number;         // negative open items (credits, unapplied payments) — reconciliation candidates
  disputed: number;          // open bills under dispute (not in bills/overdue/buckets)
  overdue: number;
  nextDue: string | null;
  items: VendorBalanceItem[];
}
export type AgeBucket = "overdue" | "next7" | "next14" | "next30" | "later" | "undated";
export interface VendorBalanceReport {
  source: "QuickBooks Vendor Balance Detail";
  realm: string;
  asOf: string;              // local date the report was pulled
  reportDate: string | null; // QuickBooks EndPeriod
  currency: string;
  columns: string[];         // report column titles as QuickBooks returned them
  totalOpen: number;         // net
  totalBills: number;
  totalUnapplied: number;
  totalDisputed: number;
  disputedCount: number;
  disputeCutoff: string | null;
  totalOverdue: number;
  buckets: Record<AgeBucket, number>;
  vendors: VendorBalance[];
  fetchedAt: string;
}

const num = (v: unknown) => { const n = parseFloat(String(v ?? "").replace(/[,\s]/g, "")); return Number.isFinite(n) ? n : 0; };
type Col = { ColTitle?: string; ColType?: string };
type Row = { type?: string; Header?: { ColData?: { value?: string; id?: string }[] }; Rows?: { Row?: Row[] }; Summary?: { ColData?: { value?: string }[] }; ColData?: { value?: string; id?: string }[] };

let cache: { at: number; report: VendorBalanceReport } | null = null;
export function invalidateVendorBalanceCache() { cache = null; }
registerCache(invalidateVendorBalanceCache);
onQboWrite(invalidateVendorBalanceCache);

export function parseVendorBalanceDetail(raw: any, realm: string, today = localDate(), disputes: DisputedBillsConfig | null = null): VendorBalanceReport {
  const disputedIds = new Set(disputes?.ids ?? []);
  const cutoff = disputes?.cutoff || null;
  const cols: Col[] = raw?.Columns?.Column || [];
  const idx = (re: RegExp) => cols.findIndex((c) => re.test(c.ColTitle || ""));
  const iDate = idx(/^date$/i), iType = idx(/type/i), iNum = idx(/^(num|no\.?)$/i), iDue = idx(/due/i), iAmt = idx(/^amount/i), iOpen = idx(/open/i);
  const vendors: VendorBalance[] = [];
  const walk = (rows: Row[] | undefined) => {
    for (const row of rows || []) {
      if (row.type === "Section" && row.Header?.ColData?.length) {
        const name = row.Header.ColData[0]?.value || "Unnamed vendor";
        const vendorId = row.Header.ColData[0]?.id || null;
        const items: VendorBalanceItem[] = [];
        for (const r of row.Rows?.Row || []) {
          if (r.type === "Section") { walk([r]); continue; }
          const c = r.ColData || [];
          const get = (i: number) => (i >= 0 ? c[i]?.value ?? "" : "");
          const dueDate = get(iDue) || null;
          const openBalance = r2(num(get(iOpen)));
          if (!get(iType) && !get(iNum) && !openBalance) continue;
          const id = c.find((x) => x?.id)?.id ?? null;
          const date = get(iDate) || null;
          const type = get(iType) || "";
          // Under review: bills in the dispute register, plus ANY positive open
          // item dated before the cutoff (opening-balance journals, old deposits)
          // — legacy balances that are not cash due until someone resolves them.
          const disputed = openBalance > 0 && ((id != null && disputedIds.has(id)) || (!!cutoff && !!date && date < cutoff));
          const daysOverdue = !disputed && dueDate && openBalance > 0 && dueDate < today ? Math.round((Date.parse(today) - Date.parse(dueDate)) / 86_400_000) : null;
          items.push({ id, date, type, num: get(iNum) || null, dueDate, amount: r2(num(get(iAmt))), openBalance, daysOverdue, disputed });
        }
        const open = r2(items.reduce((s, i) => s + i.openBalance, 0));
        const bills = r2(items.filter((i) => i.openBalance > 0 && !i.disputed).reduce((s, i) => s + i.openBalance, 0));
        const disputed = r2(items.filter((i) => i.disputed).reduce((s, i) => s + i.openBalance, 0));
        const unapplied = r2(items.filter((i) => i.openBalance < 0).reduce((s, i) => s + i.openBalance, 0));
        const overdue = r2(items.filter((i) => i.daysOverdue != null).reduce((s, i) => s + i.openBalance, 0));
        const nextDue = items.filter((i) => i.openBalance > 0 && !i.disputed && i.dueDate).map((i) => i.dueDate!).sort()[0] || null;
        if (items.length) vendors.push({ vendor: name, vendorId, open, bills, unapplied, disputed, overdue, nextDue, items });
      } else if (row.Rows?.Row) {
        walk(row.Rows.Row);
      }
    }
  };
  walk(raw?.Rows?.Row);
  vendors.sort((a, b) => b.open - a.open);
  const buckets: Record<AgeBucket, number> = { overdue: 0, next7: 0, next14: 0, next30: 0, later: 0, undated: 0 };
  for (const v of vendors) for (const i of v.items) {
    if (i.openBalance <= 0 || i.disputed) continue;
    if (!i.dueDate) buckets.undated = r2(buckets.undated + i.openBalance);
    else if (i.dueDate < today) buckets.overdue = r2(buckets.overdue + i.openBalance);
    else if (i.dueDate <= shiftDays(today, 7)) buckets.next7 = r2(buckets.next7 + i.openBalance);
    else if (i.dueDate <= shiftDays(today, 14)) buckets.next14 = r2(buckets.next14 + i.openBalance);
    else if (i.dueDate <= shiftDays(today, 30)) buckets.next30 = r2(buckets.next30 + i.openBalance);
    else buckets.later = r2(buckets.later + i.openBalance);
  }
  return {
    source: "QuickBooks Vendor Balance Detail",
    realm,
    asOf: today,
    reportDate: raw?.Header?.EndPeriod || null,
    currency: raw?.Header?.Currency || "GBP",
    columns: cols.map((c) => c.ColTitle || ""),
    totalOpen: r2(vendors.reduce((s, v) => s + v.open, 0)),
    totalBills: r2(vendors.reduce((s, v) => s + v.bills, 0)),
    totalUnapplied: r2(vendors.reduce((s, v) => s + v.unapplied, 0)),
    totalDisputed: r2(vendors.reduce((s, v) => s + v.disputed, 0)),
    disputedCount: vendors.reduce((s, v) => s + v.items.filter((i) => i.disputed).length, 0),
    disputeCutoff: cutoff,
    totalOverdue: r2(vendors.reduce((s, v) => s + v.overdue, 0)),
    buckets,
    vendors,
    fetchedAt: new Date().toISOString(),
  };
}

export async function vendorBalanceDetail(opts: { fresh?: boolean } = {}): Promise<VendorBalanceReport> {
  if (!opts.fresh && cache && Date.now() - cache.at < 5 * 60_000) return cache.report;
  const api = await qboClient();
  const [raw, disputes, registerIds] = await Promise.all([
    api.get("/reports/VendorBalanceDetail"),
    disputedBillsConfig(),
    activeDisputedBillIds().catch(() => new Set<string>()),
  ]);
  if (!raw || typeof raw !== "object") throw new FinanceError("QBO_REPORT_EMPTY", true, 502);
  // The dispute register (DISPUTE# rows) is the source of truth; the
  // supplier-terms cutoff (CONFIG#disputed-bills) still applies on top.
  const merged: DisputedBillsConfig | null = disputes || registerIds.size
    ? { cutoff: disputes?.cutoff ?? "", reason: disputes?.reason ?? "Dispute register", setAt: disputes?.setAt ?? "", setBy: disputes?.setBy ?? "", ids: Array.from(new Set([...(disputes?.ids ?? []), ...registerIds])), items: disputes?.items ?? [] }
    : null;
  const report = parseVendorBalanceDetail(raw, api.realm, localDate(), merged);
  cache = { at: Date.now(), report };
  return report;
}
