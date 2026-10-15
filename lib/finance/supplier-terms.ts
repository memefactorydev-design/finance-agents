// Supplier payment terms → QuickBooks. An owner-driven admin action:
//  1. make sure the needed Term records exist (Net N / end of following month)
//  2. put the agreed terms on each supplier (Vendor.TermRef)
//  3. re-date open bills from the cutoff onwards so due dates follow the terms
//  4. mark open bills dated before the cutoff as DISPUTED (memo in QuickBooks +
//     CONFIG#disputed-bills here) so the cashflow ignores them until resolved.
// "plan" is always read-only; "apply" writes to QuickBooks and therefore
// needs posting switched on — with it off the plan is returned as a dry run.
import { FinanceError } from "@/lib/core/domain";
import { company, financeStore } from "@/lib/core/server";
import { normName as norm } from "@/lib/core/text";
import { postingEnabled, qboClient, updateBillFields } from "@/lib/qbo/client";
import { invalidateFinanceCaches } from "./caches";
import { dueFor, parseTerm, type TermSpec } from "./terms";
import { DISPUTED_BILLS_KEY, type DisputedBillsConfig } from "./vendor-balances";

export type TermInput = { supplier: string; term: string };

// Prefix a Bill's memo in QuickBooks with the dispute tag when a dispute is
// raised against a posted bill. Full-object update through the write gate:
// with posting off it is reported as a dry run. Returns what happened so the
// caller can report it; never throws.
export async function markBillDisputed(billId: string, reason: string, raisedAt: string): Promise<{ state: "updated" | "dry_run" | "skipped" | "failed"; detail?: string }> {
  const tag = `[DISPUTED - ${reason.replace(/[\[\]]/g, "").slice(0, 120)} - raised ${raisedAt}]`;
  try {
    if (!(await postingEnabled())) return { state: "dry_run", detail: `QuickBooks posting is off; would prefix the Bill memo with ${tag}` };
    const api = await qboClient();
    const current = (await api.call(`/bill/${encodeURIComponent(billId)}`)).Bill;
    if (!current) return { state: "failed", detail: "BILL_NOT_FOUND" };
    const note: string = current.PrivateNote || "";
    if (note.includes("[DISPUTED")) return { state: "skipped", detail: "Bill memo already carries a [DISPUTED …] tag" };
    await updateBillFields(billId, { PrivateNote: `${tag} ${note}`.trim().slice(0, 4000) });
    invalidateFinanceCaches();
    return { state: "updated", detail: tag };
  } catch (e) {
    return { state: "failed", detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function applySupplierTerms(opts: { mode: "plan" | "apply"; terms: TermInput[]; cutoff: string; actor: string }) {
  const { mode, cutoff, actor } = opts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new FinanceError("CUTOFF_INVALID", false, 422);
  const api = await qboClient();
  const realm = api.realm;
  const call = (path: string, body?: unknown) => api.call(path, body === undefined ? {} : { body });
  const { query, batch } = api;

  const wanted = opts.terms.map((t) => ({ supplier: t.supplier.trim(), spec: parseTerm(t.term) })).filter((t) => t.supplier && t.spec) as { supplier: string; spec: TermSpec }[];
  const unrecognised = opts.terms.filter((t) => !parseTerm(t.term) && !/^payment term$/i.test(t.term.trim())).map((t) => `${t.supplier}: ${t.term}`);
  const posting = await postingEnabled();
  const applying = mode === "apply" && posting;

  // 1. Terms
  const [terms, vendorsAll, bills] = await Promise.all([query("Term"), query("Vendor"), query("Bill", "Balance > '0'")]);
  const termByName = new Map<string, any>(terms.map((t) => [String(t.Name).toLowerCase(), t]));
  const termsToCreate = [...new Map(wanted.map((w) => [w.spec.name, w.spec])).values()].filter((s) => !termByName.has(s.name.toLowerCase()));
  const createdTerms: string[] = [];
  if (applying && termsToCreate.length) {
    for (const s of termsToCreate) {
      let r: any;
      if (s.kind === "days") r = await call("/term", { Name: s.name, Type: "STANDARD", DueDays: s.days });
      else {
        // "Due on the last day of the month; anything dated within the month rolls to next month" = end of following month.
        try { r = await call("/term", { Name: s.name, Type: "DATE_DRIVEN", DayOfMonthDue: 31, DueNextMonthDays: 31 }); }
        catch { r = await call("/term", { Name: s.name, Type: "DATE_DRIVEN", DayOfMonthDue: 30, DueNextMonthDays: 30 }); }
      }
      termByName.set(s.name.toLowerCase(), r.Term); createdTerms.push(`${s.name} (${r.Term.Id})`);
    }
  }

  // 2. Vendors — exact display-name match first; then every vendor whose
  // normalised name is identical (QuickBooks often holds two spellings of one
  // supplier side by side — both get the terms); then prefix / contains.
  const vendors = vendorsAll.filter((v) => v.Active !== false);
  const index = vendors.map((v) => ({ v, n: norm(v.DisplayName || "") }));
  const matches: { supplier: string; vendor: any; spec: TermSpec; current: string | null }[] = [];
  const unmatched: string[] = [];
  for (const w of wanted) {
    const parts = w.supplier.split("/").map((p) => p.replace(/^x\s+/i, "").trim()).filter(Boolean);
    let hits: any[] = [];
    for (const p of parts) {
      const n = norm(p); if (!n) continue;
      const exact = index.filter((x) => (x.v.DisplayName || "").trim().toLowerCase() === p.toLowerCase());
      const sameNorm = index.filter((x) => x.n === n);
      const pool = exact.length ? [...new Set([...exact, ...sameNorm])] : sameNorm;
      hits = pool.map((x) => x.v);
      if (!hits.length) { const loose = index.find((x) => x.n.startsWith(n + " ") || n.startsWith(x.n + " ") || x.n.includes(n) || (n.length > 4 && x.n.length > 3 && n.includes(x.n))); if (loose) hits = [loose.v]; }
      if (hits.length) break;
    }
    if (!hits.length) { unmatched.push(w.supplier); continue; }
    for (const hit of hits) {
      if (matches.some((m) => m.vendor.Id === hit.Id)) continue;
      matches.push({ supplier: w.supplier, vendor: hit, spec: w.spec, current: hit.TermRef?.value ? terms.find((t) => t.Id === hit.TermRef.value)?.Name ?? hit.TermRef.value : null });
    }
  }

  // 3. Bills
  const vendorTerm = new Map<string, TermSpec>(matches.map((m) => [String(m.vendor.Id), m.spec]));
  const redate: { b: any; due: string }[] = []; const dispute: any[] = []; const untouched: any[] = [];
  for (const b of bills) {
    if (b.TxnDate < cutoff) { dispute.push(b); continue; }
    const t = vendorTerm.get(String(b.VendorRef?.value));
    if (!t) { untouched.push(b); continue; }
    const due = dueFor(b.TxnDate, t);
    if (due !== b.DueDate) redate.push({ b, due }); else untouched.push(b);
  }
  const money = (xs: any[]) => Math.round(xs.reduce((s, x) => s + Number((x.b ?? x).Balance || 0), 0) * 100) / 100;
  const byVendor = (xs: any[]) => { const m = new Map<string, number>(); for (const x of xs) { const b = x.b ?? x; m.set(b.VendorRef?.name, (m.get(b.VendorRef?.name) || 0) + Number(b.Balance)); } return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([vendor, balance]) => ({ vendor, balance: Math.round(balance * 100) / 100 })); };

  const plan = {
    mode, cutoff, realm, posting,
    terms: { existing: terms.map((t) => t.Name), toCreate: termsToCreate.map((t) => t.name), created: createdTerms },
    vendors: { matched: matches.map((m) => ({ supplier: m.supplier, vendor: m.vendor.DisplayName, vendorId: m.vendor.Id, currentTerms: m.current, newTerms: m.spec.name })), unmatched, unrecognisedTerms: unrecognised },
    bills: {
      open: { count: bills.length, balance: money(bills) },
      redate: { count: redate.length, balance: money(redate), sample: redate.slice(0, 15).map(({ b, due }) => ({ id: b.Id, date: b.TxnDate, vendor: b.VendorRef?.name, num: b.DocNumber || null, balance: Number(b.Balance), from: b.DueDate, to: due })) },
      dispute: { count: dispute.length, balance: money(dispute), byVendor: byVendor(dispute) },
      untouched: { count: untouched.length, balance: money(untouched), vendors: [...new Set(untouched.map((b) => b.VendorRef?.name))] },
    },
  };
  if (mode !== "apply") return plan;
  if (!posting) return { ...plan, applied: null, note: "QuickBooks posting is off: nothing was written. Switch posting on (Setup ▸ QuickBooks) and run apply again." };

  // Apply
  const vendorOps = matches.filter((m) => { const t = termByName.get(m.spec.name.toLowerCase()); return t && String(m.vendor.TermRef?.value) !== String(t.Id); })
    .map((m) => ({ bId: `v${m.vendor.Id}`, operation: "update" as const, entity: "Vendor", body: { Id: m.vendor.Id, SyncToken: m.vendor.SyncToken, sparse: true, TermRef: { value: termByName.get(m.spec.name.toLowerCase()).Id } } }));
  const vendorResults = await batch(vendorOps);
  // Bill has no sparse update: send the full object back with the one change
  const billOps = redate.map(({ b, due }) => ({ bId: `b${b.Id}`, operation: "update" as const, entity: "Bill", body: { ...b, DueDate: due } }));
  const billResults = await batch(billOps);
  const today = new Date().toISOString().slice(0, 10);
  const tag = `[DISPUTED - under review since ${today}; excluded from the cashflow until resolved]`;
  const disputeOps = dispute.filter((b) => !String(b.PrivateNote || "").includes("[DISPUTED"))
    .map((b) => ({ bId: `d${b.Id}`, operation: "update" as const, entity: "Bill", body: { ...b, PrivateNote: `${tag} ${b.PrivateNote || ""}`.trim().slice(0, 4000) } }));
  const disputeResults = await batch(disputeOps);

  const store = financeStore();
  const existing = await store.get<DisputedBillsConfig>(company(), DISPUTED_BILLS_KEY);
  const config: DisputedBillsConfig = {
    cutoff, reason: `Bills dated before ${cutoff} are under review with suppliers (owner instruction ${today})`, setAt: new Date().toISOString(), setBy: actor,
    ids: dispute.map((b) => String(b.Id)),
    items: dispute.map((b) => ({ id: String(b.Id), vendor: b.VendorRef?.name || "", vendorId: b.VendorRef?.value ?? null, date: b.TxnDate, num: b.DocNumber || null, balance: Number(b.Balance) })),
  };
  await store.transact(company(), [{ key: DISPUTED_BILLS_KEY, expected: existing?.version ?? null, data: config }]);
  invalidateFinanceCaches();
  const tally = (rs: { ok?: boolean }[]) => ({ ok: rs.filter((r) => r.ok).length, failed: rs.filter((r) => !r.ok) });
  return { ...plan, applied: { vendors: tally(vendorResults), billsRedated: tally(billResults), billsDisputed: tally(disputeResults), disputedConfig: { ids: config.ids.length, cutoff } } };
}
