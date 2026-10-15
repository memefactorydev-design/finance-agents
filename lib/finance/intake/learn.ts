// Learn each supplier's default coding from what was actually posted: the
// account most of a vendor's bill lines went to becomes `defaultAccountName`,
// the runner-up becomes a `categoryHints` keyword rule, and the vendor's
// QuickBooks email domain is added to `emailDomains`. Fills only empty fields
// so human edits on the profile are never overwritten. One QuickBooks query
// per vendor, serial, max 120 vendors per run with CURSOR#LEARN for the rest.
import { company, financeStore } from "@/lib/core/server";
import { qboClient, qboRefData } from "@/lib/qbo/client";
import { getSupplierProfile, upsertSupplierProfile } from "@/lib/finance/suppliers";

export interface LearnRow { vendorId: string; vendor: string; bills: number; lines: number; topAccount: string | null; share: number; defaultSet: boolean; hint: { keyword: string; account: string } | null; hintSet: boolean; domainSet: string | null; skipped?: string }
export interface LearnSummary { months: number; since: string; vendorsScanned: number; vendorsRemaining: number; cursor: string | null; profilesUpdated: number; rows: LearnRow[]; errors: string[] }

const STOP = new Set(["with", "from", "that", "this", "unit", "units", "item", "items", "each", "qty", "code", "ref", "order", "invoice", "total", "price", "white", "black", "grey", "left", "right", "hand", "size", "high", "wide", "deep", "pack", "set", "the", "and", "for", "per", "inc", "vat", "net", "mm", "cm", "x"]);
const MAX_VENDORS = 120;

export async function learnSupplierDefaults(opts: { months?: number; by: string; limit?: number } = { by: "learn" }): Promise<LearnSummary> {
  const months = Math.max(1, Math.min(opts.months ?? 12, 36));
  const sinceDate = new Date(); sinceDate.setUTCMonth(sinceDate.getUTCMonth() - months);
  const since = sinceDate.toISOString().slice(0, 10);
  const store = financeStore(); const c = company();
  const api = await qboClient();
  const ref = await qboRefData();
  const vendors = [...ref.vendors].filter((v) => v.active).sort((a, b) => a.id.localeCompare(b.id));
  const cursorRow = await store.get<{ afterVendorId: string | null; since: string }>(c, "CURSOR#LEARN");
  const after = cursorRow?.data?.since === since ? cursorRow.data.afterVendorId : null;
  const start = after ? vendors.findIndex((v) => v.id === after) + 1 : 0;
  const slice = vendors.slice(start, start + Math.max(1, Math.min(opts.limit ?? MAX_VENDORS, MAX_VENDORS)));
  const summary: LearnSummary = { months, since, vendorsScanned: 0, vendorsRemaining: 0, cursor: null, profilesUpdated: 0, rows: [], errors: [] };

  for (const v of slice) {
    summary.vendorsScanned += 1;
    const row: LearnRow = { vendorId: v.id, vendor: v.name, bills: 0, lines: 0, topAccount: null, share: 0, defaultSet: false, hint: null, hintSet: false, domainSet: null };
    try {
      const q = `select * from Bill where VendorRef = '${v.id.replace(/'/g, "\\'")}' and TxnDate >= '${since}' maxresults 1000`;
      const r = await api.call(`/query?query=${encodeURIComponent(q)}`);
      const bills: any[] = r.QueryResponse?.Bill ?? [];
      row.bills = bills.length;
      const accountCount = new Map<string, number>();
      const wordsByAccount = new Map<string, Map<string, number>>();
      for (const b of bills) for (const l of b.Line ?? []) {
        const d = l.AccountBasedExpenseLineDetail; const name = d?.AccountRef?.name; if (!name) continue;
        row.lines += 1;
        accountCount.set(name, (accountCount.get(name) || 0) + 1);
        const words = wordsByAccount.get(name) || new Map<string, number>(); wordsByAccount.set(name, words);
        for (const w of String(l.Description || "").toLowerCase().split(/[^a-z]+/).filter((x) => x.length >= 4 && !STOP.has(x))) words.set(w, (words.get(w) || 0) + 1);
      }
      const ranked = [...accountCount.entries()].sort((a, b) => b[1] - a[1]);
      const profile = await getSupplierProfile(v.id);
      const patch: Record<string, unknown> = {};
      if (ranked.length && row.lines) {
        row.topAccount = ranked[0][0]; row.share = Math.round((ranked[0][1] / row.lines) * 100) / 100;
        if (row.share >= 0.6 && !profile?.defaultAccountName) { patch.defaultAccountName = row.topAccount; row.defaultSet = true; }
        if (ranked.length > 1 && ranked[1][1] >= 2) {
          const second = ranked[1][0];
          const topWords = wordsByAccount.get(ranked[0][0]) || new Map<string, number>();
          // Keyword that is frequent for the runner-up account and not typical of the main account.
          const kw = [...(wordsByAccount.get(second) || new Map<string, number>()).entries()].filter(([w, n]) => n >= 2 && (topWords.get(w) || 0) <= n / 2).sort((a, b) => b[1] - a[1])[0]?.[0];
          if (kw) {
            row.hint = { keyword: kw, account: second };
            if (!profile?.categoryHints || !Object.keys(profile.categoryHints).length) { patch.categoryHints = { [kw]: second }; row.hintSet = true; }
          }
        }
      }
      const domain = (v.email || "").toLowerCase().split("@")[1];
      if (domain && !/^(gmail|outlook|hotmail|yahoo|icloud|live)\./.test(domain) && !(profile?.emailDomains || []).length) { patch.emailDomains = [domain]; row.domainSet = domain; }
      if (Object.keys(patch).length) {
        await upsertSupplierProfile(v.id, { vendorName: v.name, ...patch }, opts.by);
        summary.profilesUpdated += 1;
      } else if (!row.bills) row.skipped = "no bills in window";
    } catch (e) {
      row.skipped = e instanceof Error ? e.message.slice(0, 120) : "failed";
      summary.errors.push(`${v.name}: ${row.skipped}`);
    }
    summary.rows.push(row);
  }
  const last = slice[slice.length - 1];
  const remaining = vendors.length - (start + slice.length);
  summary.vendorsRemaining = Math.max(0, remaining);
  summary.cursor = remaining > 0 && last ? last.id : null;
  await store.transact(c, [{ key: "CURSOR#LEARN", expected: cursorRow?.version ?? null, data: { afterVendorId: summary.cursor, since, updatedAt: new Date().toISOString(), by: opts.by } }]).catch(() => {});
  return summary;
}
