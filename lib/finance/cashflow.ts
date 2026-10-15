// Cashflow outlook = QuickBooks bank book balances + expected client receipts
// from the project payment schedules (deposit / survey / delivery balance /
// installation / retention) − live supplier bills from the Vendor Balance
// Detail report − standing commitments, projected over 13 weeks. Read-only.
// Bank balances are the QuickBooks book balance of each bank account: the
// live bank-feed balance itself is not exposed by the QuickBooks API; the two
// agree once every bank-feed transaction has been categorised and posted.
import { r2 } from "@/lib/core/domain";
import { getSettings, updateSettings } from "@/lib/core/settings";
import { localDate, nextFriday, shiftDays } from "@/lib/core/text";
import { onQboWrite, qboClient } from "@/lib/qbo/client";
import { registerCache } from "./caches";
import { buildFinanceOverview, type DueLine } from "./overview";
import { commitmentDates, listCommitments, listSupplierProfiles, type Commitment, type SupplierProfile } from "./suppliers";
import { vendorBalanceDetail } from "./vendor-balances";

export interface BankAccount { id: string; name: string; type: "Bank" | "Credit Card"; subType: string | null; currency: string; balance: number; hidden?: boolean }

// Accounts the business no longer uses still sit in QuickBooks as Active with
// a residual book balance. Admins hide them here; hidden accounts are listed
// but excluded from the cash figure and the projection.
export interface BankAccountSettings { hidden: string[]; updatedBy?: string | null; updatedAt?: string | null }
export async function bankAccountSettings(): Promise<BankAccountSettings> {
  const s = await getSettings<BankAccountSettings>("finance_bank_accounts").catch(() => null);
  return { hidden: Array.isArray(s?.hidden) ? s!.hidden.map(String) : [], updatedBy: s?.updatedBy ?? null, updatedAt: s?.updatedAt ?? null };
}
export async function setBankAccountHidden(accountId: string, hidden: boolean, by: string): Promise<BankAccountSettings> {
  const cur = await bankAccountSettings();
  const set = new Set(cur.hidden);
  if (hidden) set.add(accountId); else set.delete(accountId);
  const next: BankAccountSettings = { hidden: Array.from(set), updatedBy: by, updatedAt: new Date().toISOString() };
  await updateSettings("finance_bank_accounts", next, by);
  cache = null;
  return next;
}

export type Bucket = "overdue" | "next7" | "next14" | "next30" | "later" | "undated";
export type InboundStage = "deposit" | "survey" | "delivery_balance" | "installation" | "retention";
export interface InboundLine { projectId: string; client: string; designer: string | null; stage: InboundStage; label: string; amount: number; dueDate: string | null; status: string; invoiceNumber: string | null; bucket: Bucket }
export interface Week { start: string; end: string; inbound: number; outbound: number; commitments: number; net: number; closing: number; inboundLines: number; outboundItems: number }
export interface SupplierOutlook { vendor: string; vendorId: string | null; open: number; overdue: number; disputed: number; maxDaysOverdue: number; nextDue: string | null; payFriday: string | null; blockAfterDaysOverdue: number | null; blockRisk: boolean; onHold: boolean; proformaOnly: boolean; pressure: SupplierProfile["pressure"] | null; paymentMethods: SupplierProfile["paymentMethods"] | null }
export interface CommitmentOutlook { id: string; kind: Commitment["kind"]; name: string; amount: number; frequency: Commitment["frequency"]; nextDue: string | null; balance: number | null }
export interface CashflowOutlook {
  asOf: string;
  fetchedAt: string;
  bank: { accounts: BankAccount[]; cash: number; creditCards: number; net: number; source: string };
  inbound: { total: number; byStage: Record<InboundStage, number>; buckets: Record<Bucket, number>; lines: InboundLine[]; source: string };
  outbound: { total: number; overdue: number; buckets: Record<Bucket, number>; underReview: number; unapplied: number; suppliers: SupplierOutlook[]; source: string };
  commitments: { total90: number; items: CommitmentOutlook[]; source: string };
  position: { available: number; in30: number; out30: number; projected30: number; low: { week: string; closing: number } | null };
  weeks: Week[];
  notes: string[];
}

const emptyBuckets = (): Record<Bucket, number> => ({ overdue: 0, next7: 0, next14: 0, next30: 0, later: 0, undated: 0 });
export function bucketFor(date: string | null, today: string): Bucket {
  if (!date) return "undated";
  if (date < today) return "overdue";
  if (date <= shiftDays(today, 7)) return "next7";
  if (date <= shiftDays(today, 14)) return "next14";
  if (date <= shiftDays(today, 30)) return "next30";
  return "later";
}
export function stageFor(key: DueLine["key"]): InboundStage {
  if (key === "deposit") return "deposit";
  if (key === "survey_payment") return "survey";
  if (key === "delivery_balance") return "delivery_balance";
  if (key === "retention") return "retention";
  return "installation";
}

// 13 weeks from today. Overdue receipts and overdue bills both land in week 1
// (they are due now); undated items are excluded. Pure (exported for tests).
export function projectWeeks(today: string, opening: number, inbound: { dueDate: string | null; amount: number }[], outbound: { date: string | null; amount: number }[], commitments: { date: string; amount: number }[], count = 13): Week[] {
  const weeks: Week[] = [];
  let closing = opening;
  for (let w = 0; w < count; w++) {
    const start = shiftDays(today, w * 7), end = shiftDays(today, w * 7 + 6);
    const inW = inbound.filter((l) => l.dueDate && (w === 0 ? l.dueDate <= end : l.dueDate >= start && l.dueDate <= end));
    const outW = outbound.filter((i) => i.date && (w === 0 ? i.date <= end : i.date >= start && i.date <= end));
    const comW = commitments.filter((i) => i.date >= start && i.date <= end);
    const inSum = r2(inW.reduce((s, l) => s + l.amount, 0)), outSum = r2(outW.reduce((s, i) => s + i.amount, 0)), committed = r2(comW.reduce((s, i) => s + i.amount, 0));
    closing = r2(closing + inSum - outSum - committed);
    weeks.push({ start, end, inbound: inSum, outbound: outSum, commitments: committed, net: r2(inSum - outSum - committed), closing, inboundLines: inW.length, outboundItems: outW.length });
  }
  return weeks;
}

let cache: { at: number; report: CashflowOutlook } | null = null;
export function invalidateCashflowCache() { cache = null; }
registerCache(invalidateCashflowCache);
onQboWrite(invalidateCashflowCache);

export async function bankBalances(): Promise<BankAccount[]> {
  const api = await qboClient();
  const [rows, settings] = await Promise.all([api.query("Account", "AccountType IN ('Bank', 'Credit Card') AND Active = true"), bankAccountSettings()]);
  const hidden = new Set(settings.hidden);
  return rows.map((a: any) => ({
    id: String(a.Id), name: a.FullyQualifiedName || a.Name, type: a.AccountType === "Credit Card" ? "Credit Card" as const : "Bank" as const,
    subType: a.AccountSubType || null, currency: a.CurrencyRef?.value || "GBP", balance: r2(Number(a.CurrentBalance || 0)),
    ...(hidden.has(String(a.Id)) ? { hidden: true } : {}),
  })).sort((a: BankAccount, b: BankAccount) => (a.hidden !== b.hidden ? (a.hidden ? 1 : -1) : a.type === b.type ? b.balance - a.balance : a.type === "Bank" ? -1 : 1));
}

export async function cashflowOutlook(opts: { fresh?: boolean } = {}): Promise<CashflowOutlook> {
  if (!opts.fresh && cache && Date.now() - cache.at < 5 * 60_000) return cache.report;
  const today = localDate();
  const notes: string[] = [];
  // Without a QuickBooks connection the outlook still projects receipts and
  // commitments from a zero opening balance, so the CRM side stays usable.
  const [accounts, overview, suppliers] = await Promise.all([
    bankBalances().catch((e) => { notes.push(`Bank balances unavailable: ${e instanceof Error ? e.message : "error"} — connect QuickBooks; the projection below starts from £0.`); return [] as BankAccount[]; }),
    buildFinanceOverview({ pnlLimit: 1, ledger: null }),
    vendorBalanceDetail({ fresh: opts.fresh }).catch((e) => { notes.push(`Supplier bills unavailable: ${e instanceof Error ? e.message : "error"}`); return null; }),
  ]);
  const inUse = accounts.filter((a) => !a.hidden);
  const cash = r2(inUse.filter((a) => a.type === "Bank").reduce((s, a) => s + a.balance, 0));
  const creditCards = r2(inUse.filter((a) => a.type === "Credit Card").reduce((s, a) => s + a.balance, 0));

  // Inbound: every unpaid schedule line across active projects (CRM schedule; not yet reconciled to the bank)
  const lines: InboundLine[] = overview.dueLines
    .filter((l) => l.outstandingGross > 0 && l.status !== "paid")
    .map((l) => ({ projectId: l.projectId, client: l.client, designer: l.designer, stage: stageFor(l.key), label: l.label, amount: r2(l.outstandingGross), dueDate: l.dueDate, status: l.status, invoiceNumber: l.invoiceNumber, bucket: bucketFor(l.dueDate, today) }))
    .sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
  const byStage: Record<InboundStage, number> = { deposit: 0, survey: 0, delivery_balance: 0, installation: 0, retention: 0 };
  const inBuckets = emptyBuckets();
  for (const l of lines) { byStage[l.stage] = r2(byStage[l.stage] + l.amount); inBuckets[l.bucket] = r2(inBuckets[l.bucket] + l.amount); }
  const inboundTotal = r2(lines.reduce((s, l) => s + l.amount, 0));
  if (inBuckets.undated) notes.push(`${inBuckets.undated.toLocaleString("en-GB")} of expected receipts have no date yet (survey / delivery not scheduled) — excluded from the weekly projection.`);

  // Outbound: live supplier bills (disputed / under-review excluded), overlaid with the supplier playbook
  const [profiles, commitments] = await Promise.all([listSupplierProfiles().catch(() => [] as SupplierProfile[]), listCommitments().catch(() => [] as Commitment[])]);
  const profileFor = (vendorId: string | null, name: string) => profiles.find((p) => (vendorId && p.vendorId === vendorId) || p.vendorName.toLowerCase() === name.toLowerCase() || p.aliases.some((a) => a.toLowerCase() === name.toLowerCase())) || null;
  const outBuckets = emptyBuckets();
  const outItems: { date: string | null; amount: number }[] = [];
  const supplierRows: SupplierOutlook[] = [];
  if (suppliers) for (const v of suppliers.vendors) {
    let maxDays = 0;
    for (const i of v.items) {
      if (i.openBalance <= 0 || i.disputed) continue;
      outItems.push({ date: i.dueDate, amount: i.openBalance });
      outBuckets[bucketFor(i.dueDate, today)] = r2(outBuckets[bucketFor(i.dueDate, today)] + i.openBalance);
      if (i.daysOverdue != null) maxDays = Math.max(maxDays, i.daysOverdue);
    }
    if (v.bills <= 0 && v.disputed <= 0) continue;
    const p = profileFor(v.vendorId, v.vendor);
    const block = p?.blockAfterDaysOverdue ?? null;
    supplierRows.push({
      vendor: v.vendor, vendorId: v.vendorId, open: v.bills, overdue: v.overdue, disputed: v.disputed, maxDaysOverdue: maxDays, nextDue: v.nextDue,
      payFriday: v.nextDue ? nextFriday(v.nextDue < today ? today : v.nextDue) : null,
      blockAfterDaysOverdue: block, blockRisk: !!p?.onHold || !!p?.proformaOnly || (block != null && maxDays >= block - 3),
      onHold: !!p?.onHold, proformaOnly: !!p?.proformaOnly, pressure: p?.pressure ?? null, paymentMethods: p?.paymentMethods ?? null,
    });
  }
  supplierRows.sort((a, b) => Number(b.blockRisk) - Number(a.blockRisk) || b.overdue - a.overdue);
  const outboundTotal = r2(outItems.reduce((s, i) => s + i.amount, 0));

  // Standing commitments (loans, overheads, payroll, VAT, cards) over the 13 weeks
  const horizonEnd = shiftDays(today, 90);
  const commitmentItems: { date: string; amount: number; id: string }[] = [];
  for (const c of commitments) for (const d of commitmentDates(c, today, horizonEnd)) commitmentItems.push({ date: d, amount: c.amount, id: c.id });
  const commitmentRows: CommitmentOutlook[] = commitments.map((c) => ({ id: c.id, kind: c.kind, name: c.name, amount: c.amount, frequency: c.frequency, nextDue: commitmentDates(c, today, horizonEnd)[0] ?? null, balance: c.balance }));
  const commitments90 = r2(commitmentItems.reduce((s, i) => s + i.amount, 0));
  if (suppliers?.totalUnapplied) notes.push(`${Math.abs(suppliers.totalUnapplied).toLocaleString("en-GB")} of supplier payments/credits are unapplied in QuickBooks — bills may already be paid; reconcile before chasing or paying.`);
  if (suppliers?.totalDisputed) notes.push(`${suppliers.totalDisputed.toLocaleString("en-GB")} of supplier items are under review / disputed and excluded${suppliers.disputeCutoff ? ` (cutoff ${suppliers.disputeCutoff})` : ""}.`);
  if (inUse.some((a) => a.type === "Credit Card" && a.balance > 0) && inUse.some((a) => a.type === "Credit Card" && a.balance < 0)) notes.push("Credit-card balances carry mixed signs in QuickBooks (some positive, some negative), so card debt is listed per account and not netted into the bank balance — reconcile the card accounts.");
  if (accounts.some((a) => a.hidden)) notes.push(`${accounts.filter((a) => a.hidden).length} retired account${accounts.filter((a) => a.hidden).length === 1 ? "" : "s"} hidden from the cash figure (${accounts.filter((a) => a.hidden).map((a) => a.name).join(", ")}).`);
  if (!commitments.length) notes.push("No standing commitments recorded yet (loans, rent, payroll, VAT) — add them (upsert_commitment / POST /api/finance/commitments) so the projection includes them.");
  notes.push("Bank figures are the QuickBooks book balance per account. The live bank-feed balance is not available through the QuickBooks API; the two agree once every bank-feed transaction has been categorised and posted.");

  const weeks = projectWeeks(today, cash, lines, outItems, commitmentItems);
  const in30 = r2(inBuckets.overdue + inBuckets.next7 + inBuckets.next14 + inBuckets.next30);
  const out30 = r2(outBuckets.overdue + outBuckets.next7 + outBuckets.next14 + outBuckets.next30 + commitmentItems.filter((i) => i.date <= shiftDays(today, 30)).reduce((s, i) => s + i.amount, 0));
  const low = weeks.reduce<Week | null>((m, w) => (m === null || w.closing < m.closing ? w : m), null);

  const report: CashflowOutlook = {
    asOf: today, fetchedAt: new Date().toISOString(),
    bank: { accounts, cash, creditCards, net: r2(cash + creditCards), source: "QuickBooks bank + credit card accounts (book balance)" },
    inbound: { total: inboundTotal, byStage, buckets: inBuckets, lines, source: "Project payment schedules (deposit / survey / delivery / installation / retention), unreconciled" },
    outbound: { total: outboundTotal, overdue: outBuckets.overdue, buckets: outBuckets, underReview: suppliers?.totalDisputed ?? 0, unapplied: suppliers?.totalUnapplied ?? 0, suppliers: supplierRows, source: "QuickBooks Vendor Balance Detail (live bills only) + supplier playbook" },
    commitments: { total90: commitments90, items: commitmentRows, source: "Standing commitments (loans, overheads, payroll, VAT, cards) recorded in the finance store" },
    position: { available: cash, in30, out30, projected30: r2(cash + in30 - out30), low: low ? { week: low.start, closing: low.closing } : null },
    weeks, notes,
  };
  cache = { at: Date.now(), report };
  return report;
}
