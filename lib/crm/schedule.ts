// Order finance: the single money model for a won project. Pure functions
// (no I/O) shared by the UI, the API routes, the MCP tools and the tests.
//  • wonValue is the NET order value ex VAT, EXCLUDING installation.
//  • Installation is a separate contract (net value on orderFinance.installation).
//  • Schedule amounts and payments are GROSS (inc VAT).
//  • Defaults: 35% on order, 35% on survey sign-off, balance 14 days before
//    delivery; installation 20% deposit, then 50% / 50% of the balance on
//    Day 1 / Stage 1 with an optional 10% retention to Stage 2. Every default is
//    editable per project (pct or absolute amount) and in Settings.
import { r2 } from "@/lib/core/domain";
import { type Invoice, type OrderFinance, type Payment, type Project, type ScheduleGroup, type ScheduleKey, type ScheduleLine, SCHEDULE_KEYS } from "./types";

export { SCHEDULE_KEYS };
export type { ScheduleKey, ScheduleGroup, ScheduleLine, OrderFinance };
export const round2 = r2;

export interface FinanceDefaults { defaultVatRate: number; depositPct: number; surveyPct: number; installDepositPct: number; installDay1Pct: number; retentionPct: number }
export const FINANCE_DEFAULTS: FinanceDefaults = { defaultVatRate: 20, depositPct: 35, surveyPct: 35, installDepositPct: 20, installDay1Pct: 50, retentionPct: 10 };

export type DueRule = "wonDate" | "surveyOrderAt" | "deliveryDate-14d" | "installStart" | "signOff1At" | "signOff2At";
export const SCHEDULE_META: Record<ScheduleKey, { label: string; short: string; group: ScheduleGroup; trigger: string; dueRule: DueRule; defaultPct: keyof FinanceDefaults | null }> = {
  deposit: { label: "Deposit", short: "Deposit", group: "order", trigger: "Payable on sales order", dueRule: "wonDate", defaultPct: "depositPct" },
  survey_payment: { label: "Survey payment", short: "Survey", group: "order", trigger: "On survey order sign-off", dueRule: "surveyOrderAt", defaultPct: "surveyPct" },
  delivery_balance: { label: "Delivery balance", short: "Delivery", group: "order", trigger: "14 days before delivery", dueRule: "deliveryDate-14d", defaultPct: null },
  install_deposit: { label: "Installation deposit", short: "Install deposit", group: "installation", trigger: "On installation contract", dueRule: "wonDate", defaultPct: "installDepositPct" },
  install_day1: { label: "Due Day 1", short: "Day 1", group: "installation", trigger: "Installation day 1 · half the balance after the deposit", dueRule: "installStart", defaultPct: "installDay1Pct" },
  install_stage1: { label: "Due on Stage 1 sign-off", short: "Stage 1", group: "installation", trigger: "Stage 1 sign-off · the other half", dueRule: "signOff1At", defaultPct: null },
  retention: { label: "Retention", short: "Retention", group: "installation", trigger: "Held until Stage 2 sign-off", dueRule: "signOff2At", defaultPct: "retentionPct" },
};

export const grossFromNet = (net: number, vatRate: number) => round2(net * (1 + vatRate / 100));
export const netFromGross = (gross: number, vatRate: number) => round2(gross / (1 + vatRate / 100));

export type FinanceProject = Pick<Project, "wonValue" | "wonDate" | "orderFinance" | "surveyOrderAt" | "deliveryDate" | "installStart" | "signOff1At" | "signOff2At" | "stage1Date" | "stage2Date" | "payments" | "invoices">;

export function vatRateOf(p: Pick<Project, "orderFinance">, defaults: FinanceDefaults = FINANCE_DEFAULTS): number { const v = p.orderFinance?.vatRate; return typeof v === "number" && v >= 0 ? v : defaults.defaultVatRate; }
export function orderNet(p: Pick<Project, "wonValue">): number { return round2(p.wonValue || 0); }
export function orderGross(p: Pick<Project, "wonValue" | "orderFinance">, defaults = FINANCE_DEFAULTS): number { return grossFromNet(orderNet(p), vatRateOf(p, defaults)); }
export function orderVat(p: Pick<Project, "wonValue" | "orderFinance">, defaults = FINANCE_DEFAULTS): number { return round2(orderGross(p, defaults) - orderNet(p)); }
export function installNet(p: Pick<Project, "orderFinance">): number { return round2(p.orderFinance?.installation?.value || 0); }
export function installVatRate(p: Pick<Project, "orderFinance">, defaults = FINANCE_DEFAULTS): number { const v = p.orderFinance?.installation?.vatRate; return typeof v === "number" && v >= 0 ? v : vatRateOf(p, defaults); }
export function installGross(p: Pick<Project, "orderFinance">, defaults = FINANCE_DEFAULTS): number { return grossFromNet(installNet(p), installVatRate(p, defaults)); }
export function contractGross(p: Pick<Project, "wonValue" | "orderFinance">, defaults = FINANCE_DEFAULTS): number { return round2(orderGross(p, defaults) + installGross(p, defaults)); }
export function contractNet(p: Pick<Project, "wonValue" | "orderFinance">): number { return round2(orderNet(p) + installNet(p)); }

export const invoiceNet = (inv: Invoice) => round2(inv.items.reduce((s, i) => s + i.qty * i.unitPrice, 0));
export const invoiceVat = (inv: Invoice) => round2(invoiceNet(inv) * (inv.vatRate / 100));
export const invoiceTotal = (inv: Invoice) => round2(invoiceNet(inv) + invoiceVat(inv));
export const paymentsTaken = (payments?: Payment[] | null) => round2((payments || []).reduce((s, p) => s + (p.amount || 0), 0));

export type LineStatus = "n/a" | "tbc" | "upcoming" | "due" | "overdue" | "part" | "paid";
export interface ResolvedLine { key: ScheduleKey; label: string; group: ScheduleGroup; trigger: string; applicable: boolean; pct: number | null; amountGross: number; amountNet: number; vat: number; vatRate: number; overridden: boolean; dueDate: string | null; dueRule: DueRule; dueSource: "manual" | "derived" | "none"; invoiceId: string | null; invoice: Invoice | null; paidGross: number; outstandingGross: number; status: LineStatus; note?: string }

const isoDate = (v: string | null | undefined): string | null => { if (!v || v === "N/A") return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
const shiftDays = (iso: string, days: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
function derivedDueDate(p: FinanceProject, rule: DueRule): string | null {
  switch (rule) {
    case "wonDate": return isoDate(p.wonDate);
    case "surveyOrderAt": return isoDate(p.surveyOrderAt);
    case "deliveryDate-14d": { const d = isoDate(p.deliveryDate); return d ? shiftDays(d, -14) : null; }
    case "installStart": return isoDate(p.installStart);
    case "signOff1At": return isoDate(p.signOff1At) || isoDate(p.stage1Date);
    case "signOff2At": return isoDate(p.signOff2At) || isoDate(p.stage2Date);
  }
}
export function allocatePayments(payments: Payment[] | null | undefined, lines: { key: ScheduleKey; amountGross: number; applicable: boolean }[]): { byKey: Record<ScheduleKey, number>; unallocated: number } {
  const byKey = Object.fromEntries(SCHEDULE_KEYS.map((k) => [k, 0])) as Record<ScheduleKey, number>;
  let untagged = 0;
  for (const p of payments || []) {
    const amt = Number(p.amount) || 0; if (amt <= 0) continue;
    if (p.scheduleKey && (SCHEDULE_KEYS as readonly string[]).includes(p.scheduleKey)) byKey[p.scheduleKey] = round2(byKey[p.scheduleKey] + amt); else untagged = round2(untagged + amt);
  }
  for (const line of lines) {
    if (untagged <= 0) break;
    if (!line.applicable) continue;
    const room = round2(line.amountGross - byKey[line.key]); if (room <= 0) continue;
    const take = Math.min(room, untagged); byKey[line.key] = round2(byKey[line.key] + take); untagged = round2(untagged - take);
  }
  return { byKey, unallocated: untagged };
}
export interface ResolveOptions { defaults?: FinanceDefaults; today?: string }
export function resolveSchedule(p: FinanceProject, opts: ResolveOptions = {}): ResolvedLine[] {
  const defaults = opts.defaults || FINANCE_DEFAULTS;
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const of = p.orderFinance;
  const vatRate = vatRateOf(p, defaults), iVatRate = installVatRate(p, defaults);
  const oGross = orderGross(p, defaults), iGross = installGross(p, defaults);
  const hasInstall = !!of?.installation && iGross > 0;
  const retentionOn = !!of?.installation?.retentionApplies && hasInstall;
  const invoices = (p.invoices || []).filter((i) => i.status !== "void");
  const line = (key: ScheduleKey): ScheduleLine => of?.schedule?.[key] || { pct: null, amount: null, overridden: false };
  const pctOf = (key: ScheduleKey, base: number) => {
    const l = line(key), meta = SCHEDULE_META[key];
    if (l.amount != null) return { amount: round2(l.amount), pct: base > 0 ? round2((l.amount / base) * 100) : null, overridden: true };
    const pct = l.pct != null ? l.pct : meta.defaultPct ? defaults[meta.defaultPct] : 0;
    return { amount: round2(base * (pct / 100)), pct, overridden: !!l.overridden || l.pct != null };
  };
  const invoicedAmount = (key: ScheduleKey) => { const id = line(key).invoiceId; const inv = id ? invoices.find((i) => i.id === id) || null : null; return { invoice: inv, amount: inv ? invoiceTotal(inv) : null }; };
  const amounts = {} as Record<ScheduleKey, { amount: number; pct: number | null; overridden: boolean; applicable: boolean; base: number; rate: number }>;
  const dep = pctOf("deposit", oGross), sur = pctOf("survey_payment", oGross);
  const depAmt = invoicedAmount("deposit").amount ?? dep.amount, surAmt = invoicedAmount("survey_payment").amount ?? sur.amount;
  amounts.deposit = { amount: depAmt, pct: dep.pct, overridden: dep.overridden, applicable: oGross > 0, base: oGross, rate: vatRate };
  amounts.survey_payment = { amount: surAmt, pct: sur.pct, overridden: sur.overridden, applicable: oGross > 0, base: oGross, rate: vatRate };
  const delL = line("delivery_balance"), delInv = invoicedAmount("delivery_balance").amount;
  const delAmt = delInv ?? (delL.amount != null ? round2(delL.amount) : delL.pct != null ? round2(oGross * (delL.pct / 100)) : Math.max(0, round2(oGross - depAmt - surAmt)));
  amounts.delivery_balance = { amount: delAmt, pct: oGross > 0 ? round2((delAmt / oGross) * 100) : null, overridden: delL.amount != null || delL.pct != null, applicable: oGross > 0, base: oGross, rate: vatRate };
  const idep = pctOf("install_deposit", iGross), idepAmt = invoicedAmount("install_deposit").amount ?? idep.amount;
  const iBalance = Math.max(0, round2(iGross - idepAmt));
  const iday = pctOf("install_day1", iBalance);
  const iret = retentionOn ? pctOf("retention", iGross) : { amount: 0, pct: null as number | null, overridden: false };
  const idayAmt = invoicedAmount("install_day1").amount ?? iday.amount, iretAmt = invoicedAmount("retention").amount ?? iret.amount;
  amounts.install_deposit = { amount: hasInstall ? idepAmt : 0, pct: idep.pct, overridden: idep.overridden, applicable: hasInstall, base: iGross, rate: iVatRate };
  amounts.install_day1 = { amount: hasInstall ? idayAmt : 0, pct: iday.pct, overridden: iday.overridden, applicable: hasInstall, base: iBalance, rate: iVatRate };
  amounts.retention = { amount: retentionOn ? iretAmt : 0, pct: retentionOn ? iret.pct : null, overridden: iret.overridden, applicable: retentionOn, base: iGross, rate: iVatRate };
  const s1L = line("install_stage1"), s1Inv = invoicedAmount("install_stage1").amount;
  const s1Amt = !hasInstall ? 0 : s1Inv ?? (s1L.amount != null ? round2(s1L.amount) : s1L.pct != null ? round2(iGross * (s1L.pct / 100)) : Math.max(0, round2(iGross - idepAmt - idayAmt - (retentionOn ? iretAmt : 0))));
  amounts.install_stage1 = { amount: s1Amt, pct: iGross > 0 ? round2((s1Amt / iGross) * 100) : null, overridden: s1L.amount != null || s1L.pct != null, applicable: hasInstall, base: iGross, rate: iVatRate };
  const { byKey } = allocatePayments(p.payments, SCHEDULE_KEYS.map((key) => ({ key, amountGross: amounts[key].amount, applicable: amounts[key].applicable })));
  return SCHEDULE_KEYS.map((key) => {
    const meta = SCHEDULE_META[key], a = amounts[key], l = line(key);
    const { invoice } = invoicedAmount(key);
    const manual = isoDate(l.dueDate), derived = derivedDueDate(p, meta.dueRule), dueDate = manual || derived;
    const paidGross = a.applicable ? round2(byKey[key]) : 0;
    const outstandingGross = a.applicable ? Math.max(0, round2(a.amount - paidGross)) : 0;
    let status: LineStatus;
    if (!a.applicable || a.amount <= 0) status = "n/a";
    else if (outstandingGross <= 0.005) status = "paid";
    else if (paidGross > 0) status = "part";
    else if (!dueDate) status = "tbc";
    else if (dueDate < today) status = "overdue";
    else if (shiftDays(today, 7) >= dueDate) status = "due";
    else status = "upcoming";
    const amountNet = netFromGross(a.amount, a.rate);
    return { key, label: meta.label, group: meta.group, trigger: meta.trigger, applicable: a.applicable, pct: a.pct, amountGross: a.amount, amountNet, vat: round2(a.amount - amountNet), vatRate: a.rate, overridden: a.overridden, dueDate, dueRule: meta.dueRule, dueSource: manual ? "manual" : derived ? "derived" : "none", invoiceId: invoice ? invoice.id : null, invoice, paidGross, outstandingGross, status, note: l.note };
  });
}
export interface ScheduleTotals { totalGross: number; paidGross: number; outstandingGross: number; order: { totalGross: number; paidGross: number; outstandingGross: number }; installation: { totalGross: number; paidGross: number; outstandingGross: number }; overdueGross: number }
export function scheduleTotals(lines: ResolvedLine[]): ScheduleTotals {
  const sum = (rows: ResolvedLine[]) => ({ totalGross: round2(rows.reduce((s, r) => s + (r.applicable ? r.amountGross : 0), 0)), paidGross: round2(rows.reduce((s, r) => s + r.paidGross, 0)), outstandingGross: round2(rows.reduce((s, r) => s + r.outstandingGross, 0)) });
  const all = sum(lines);
  return { ...all, order: sum(lines.filter((l) => l.group === "order")), installation: sum(lines.filter((l) => l.group === "installation")), overdueGross: round2(lines.filter((l) => l.status === "overdue").reduce((s, l) => s + l.outstandingGross, 0)) };
}
export function emptyOrderFinance(defaults: FinanceDefaults = FINANCE_DEFAULTS, by?: string): OrderFinance { return { vatRate: defaults.defaultVatRate, schedule: {}, installation: null, updatedAt: new Date().toISOString(), updatedBy: by }; }
export function mergeOrderFinance(current: OrderFinance | null | undefined, patch: Partial<Pick<OrderFinance, "vatRate" | "installation">> & { schedule?: Partial<Record<ScheduleKey, Partial<ScheduleLine> | null>> }, by?: string, defaults: FinanceDefaults = FINANCE_DEFAULTS): OrderFinance {
  const base = current || emptyOrderFinance(defaults, by);
  const schedule: OrderFinance["schedule"] = { ...base.schedule };
  for (const [k, v] of Object.entries(patch.schedule || {})) { const key = k as ScheduleKey; if (v === null) delete schedule[key]; else schedule[key] = { pct: null, amount: null, overridden: false, ...(schedule[key] || {}), ...v }; }
  return { vatRate: patch.vatRate ?? base.vatRate, installation: patch.installation === undefined ? base.installation : patch.installation, schedule, updatedAt: new Date().toISOString(), updatedBy: by };
}
export const gbp = (v: number, fraction = 0, currency = "GBP") => new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: fraction, maximumFractionDigits: fraction }).format(v || 0);
export const gbp2 = (v: number) => gbp(v, 2);
export function invoicesToAutoMarkPaid(p: FinanceProject, opts: ResolveOptions = {}): Invoice[] {
  return resolveSchedule(p, opts).filter((l) => l.status === "paid" && l.invoice && (l.invoice.status === "draft" || l.invoice.status === "sent")).map((l) => l.invoice as Invoice);
}
