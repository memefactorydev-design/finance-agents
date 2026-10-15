// QuickBooks Profit & Loss reports for the finance reports and the commission
// engine. Two shapes are read:
//   • ProfitAndLoss summarised by month (the "P&L by Month" tab: income, GP,
//     net, deals, averages, GP% / NP% / AOV per month)
//   • ProfitAndLoss filtered to one Class (= one customer project) — the
//     "Profit and Loss by Class" per delivered project
// Row names and order are taken from the report response itself so the tab
// mirrors the QuickBooks export. Per-class reports are cached in the finance
// store (PNL_CLASS#<classId>#<yyyy-mm>): closed months for a week, the
// current month for 24h. Read-only against QuickBooks.
import { FinanceError, r2 } from "@/lib/core/domain";
import { company, financeStore } from "@/lib/core/server";
import { localDate } from "@/lib/core/text";
import { listProjects } from "@/lib/crm/projects";
import { projectName, type Invoice, type Project } from "@/lib/crm/types";
import { classByCustomer, qboClient, qboRefData, type QboRef } from "@/lib/qbo/client";

// ------------------------------------------------------------------ helpers
export const monthKeyOf = (iso: string) => iso.slice(0, 7);
export const currentMonth = () => monthKeyOf(localDate());
export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (month: string) => { const [y, m] = month.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; };
const num = (v: unknown) => { const n = parseFloat(String(v ?? "").replace(/[,\s£$€]/g, "")); return Number.isFinite(n) ? n : 0; };
const isIsoDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
const pct = (part: number, whole: number) => (whole > 0 ? r2((part / whole) * 100) : null);
const avg = (sum: number, n: number) => (n > 0 ? r2(sum / n) : null);

// ------------------------------------------------------------ report parser
type ColData = { value?: string; id?: string };
type RawRow = { type?: string; group?: string; Header?: { ColData?: ColData[] }; Rows?: { Row?: RawRow[] }; Summary?: { ColData?: ColData[] }; ColData?: ColData[] };
type RawCol = { ColTitle?: string; ColType?: string; MetaData?: { Name?: string; Value?: string }[] };

export interface PnlFlatRow {
  label: string;
  kind: "header" | "data" | "summary";
  depth: number;
  group: string | null;        // QuickBooks section group (Income, COGS, GrossProfit, Expenses, NetOperatingIncome, OtherExpenses, NetIncome…)
  accountId: string | null;
  values: number[];            // one per money column, in column order
}
export interface ParsedPnl {
  columns: { title: string; start: string | null; end: string | null }[]; // money columns only
  rows: PnlFlatRow[];
}

export function parseProfitAndLoss(raw: any): ParsedPnl {
  const cols: RawCol[] = raw?.Columns?.Column || [];
  const moneyIdx: number[] = [];
  const columns: ParsedPnl["columns"] = [];
  cols.forEach((c, i) => {
    if (i === 0 && (c.ColType === "Account" || !c.ColType)) return;
    if (c.ColType && c.ColType !== "Money") return;
    moneyIdx.push(i);
    const meta = (name: string) => c.MetaData?.find((m) => m.Name === name)?.Value || null;
    columns.push({ title: c.ColTitle || "", start: meta("StartDate"), end: meta("EndDate") });
  });
  const rows: PnlFlatRow[] = [];
  const valuesOf = (cd: ColData[] | undefined) => moneyIdx.map((i) => r2(num(cd?.[i]?.value)));
  const walk = (list: RawRow[] | undefined, depth: number, inheritedGroup: string | null) => {
    for (const row of list || []) {
      const group = row.group || inheritedGroup;
      if (row.type === "Section" || row.Header || row.Rows || row.Summary) {
        if (row.Header?.ColData?.length) {
          const label = row.Header.ColData[0]?.value || "";
          if (label) rows.push({ label, kind: "header", depth, group, accountId: row.Header.ColData[0]?.id || null, values: valuesOf(row.Header.ColData) });
        }
        walk(row.Rows?.Row, depth + (row.Header?.ColData?.length ? 1 : 0), group);
        if (row.Summary?.ColData?.length) {
          const label = row.Summary.ColData[0]?.value || "";
          if (label) rows.push({ label, kind: "summary", depth, group, accountId: null, values: valuesOf(row.Summary.ColData) });
        }
      } else if (row.ColData?.length) {
        const label = row.ColData[0]?.value || "";
        if (!label) continue;
        rows.push({ label, kind: "data", depth, group, accountId: row.ColData[0]?.id || null, values: valuesOf(row.ColData) });
      }
    }
  };
  walk(raw?.Rows?.Row, 0, null);
  return { columns, rows };
}

// The headline figures of one money column, found by QuickBooks group first
// and by the English row name as a fallback (older realms omit `group`).
export interface PnlSummary { income: number; cogs: number; grossProfit: number; expenses: number; netOperatingIncome: number; otherExpenses: number; netIncome: number }
export function summariseColumn(p: ParsedPnl, col: number): PnlSummary {
  const find = (group: string, re: RegExp) =>
    p.rows.find((r) => r.kind === "summary" && r.group === group)?.values[col]
    ?? p.rows.find((r) => r.kind === "summary" && re.test(r.label))?.values[col]
    ?? 0;
  const income = find("Income", /^total income$/i);
  const cogs = find("COGS", /^total cost of (sales|goods sold)$/i);
  const grossProfit = p.rows.find((r) => r.group === "GrossProfit")?.values[col] ?? p.rows.find((r) => /^gross profit$/i.test(r.label))?.values[col] ?? r2(income - cogs);
  const expenses = find("Expenses", /^total expenses$/i);
  const netOperatingIncome = p.rows.find((r) => r.group === "NetOperatingIncome")?.values[col] ?? p.rows.find((r) => /^net operating income$/i.test(r.label))?.values[col] ?? r2(grossProfit - expenses);
  const otherExpenses = find("OtherExpenses", /^total other expenses$/i);
  const netIncome = p.rows.find((r) => r.group === "NetIncome")?.values[col] ?? p.rows.find((r) => /^net income$/i.test(r.label))?.values[col] ?? r2(netOperatingIncome - otherExpenses);
  return { income: r2(income), cogs: r2(cogs), grossProfit: r2(grossProfit), expenses: r2(expenses), netOperatingIncome: r2(netOperatingIncome), otherExpenses: r2(otherExpenses), netIncome: r2(netIncome) };
}
export const emptySummary = (): PnlSummary => ({ income: 0, cogs: 0, grossProfit: 0, expenses: 0, netOperatingIncome: 0, otherExpenses: 0, netIncome: 0 });
export const addSummary = (a: PnlSummary, b: PnlSummary): PnlSummary => ({ income: r2(a.income + b.income), cogs: r2(a.cogs + b.cogs), grossProfit: r2(a.grossProfit + b.grossProfit), expenses: r2(a.expenses + b.expenses), netOperatingIncome: r2(a.netOperatingIncome + b.netOperatingIncome), otherExpenses: r2(a.otherExpenses + b.otherExpenses), netIncome: r2(a.netIncome + b.netIncome) });

// --------------------------------------------------------- project completion
// When is a project complete? Stage 2 sign-off for installed jobs; the
// delivery date for supply-only ones; the CRM's completedAt stamp when it has
// one. One answer for the P&L, the commission engine and the reports.
export type CompletionSource = "deliveryDate" | "stage2Date" | "signOff2At" | "completedAt" | "fallback";
type CompletionProject = Pick<Project, "supplyOnly" | "deliveryDate" | "stage2Date" | "signOff2At" | "completedAt" | "opsStage" | "invoices">;
const FINAL_KEYS = new Set(["delivery_balance", "install_stage1", "retention"]);

export function hasFinalInvoice(p: Pick<Project, "invoices">): boolean {
  return (p.invoices || []).some((i: Invoice) => i.status !== "void" && i.status !== "draft" && ((i.scheduleKey && FINAL_KEYS.has(i.scheduleKey)) || /final|balance/i.test(i.items?.[0]?.description || "")));
}
export function projectCompletionDate(p: CompletionProject, today = localDate()): { date: string; source: CompletionSource } | null {
  if (p.supplyOnly) {
    const d = isIsoDate(p.deliveryDate) ? p.deliveryDate.slice(0, 10) : null;
    return d && d <= today ? { date: d, source: "deliveryDate" } : null;
  }
  if (isIsoDate(p.stage2Date)) return { date: p.stage2Date.slice(0, 10), source: "stage2Date" };
  if (isIsoDate(p.signOff2At)) return { date: p.signOff2At.slice(0, 10), source: "signOff2At" };
  if (isIsoDate(p.completedAt)) return { date: p.completedAt.slice(0, 10), source: "completedAt" };
  // No sign-off stamped but the job is in its closing stage with a final
  // invoice out: take the latest invoice date and flag it as inferred.
  if (/stage 2|customer service|complete/i.test(p.opsStage || "") && hasFinalInvoice(p)) {
    const d = (p.invoices || []).filter((i) => i.status !== "void").map((i) => i.date).sort().at(-1);
    if (isIsoDate(d)) return { date: d.slice(0, 10), source: "fallback" };
  }
  return null;
}
// The cost cut-off the live P&L freezes at.
export function completionCutoff(p: Pick<Project, "supplyOnly" | "deliveryDate" | "signOff2At" | "stage2Date">, today = localDate()): string | null {
  if (p.supplyOnly) return isIsoDate(p.deliveryDate) && p.deliveryDate.slice(0, 10) <= today ? p.deliveryDate.slice(0, 10) : null;
  return p.signOff2At || p.stage2Date || null;
}

export interface CompletedProject {
  projectId: string;
  client: string;
  designer: string;              // display name ("Unassigned" when the CRM has none)
  completionDate: string;        // YYYY-MM-DD
  completionSource: CompletionSource;
  wonDate: string | null;
  wonValue: number;
  opsStage: string | null;
  hasFinalInvoice: boolean;
  remedialsOpen: boolean;
  project: Project;
}
export const designerDisplayName = (designer: string | null | undefined) =>
  designer ? (designer.includes("@") ? designer.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : designer) : "Unassigned";

export async function completedProjects(month?: string): Promise<CompletedProject[]> {
  const projects = (await listProjects({ status: "all" })).filter((p) => p.status === "active" || p.status === "completed");
  const out: CompletedProject[] = [];
  for (const p of projects) {
    const c = projectCompletionDate(p);
    if (!c) continue;
    if (month && monthKeyOf(c.date) !== month) continue;
    out.push({
      projectId: p.id, client: projectName(p), designer: designerDisplayName(p.designer),
      completionDate: c.date, completionSource: c.source, wonDate: p.wonDate, wonValue: p.wonValue || 0, opsStage: p.opsStage || null,
      hasFinalInvoice: hasFinalInvoice(p), remedialsOpen: /remedial/i.test(p.opsStage || ""), project: p,
    });
  }
  return out.sort((a, b) => a.completionDate.localeCompare(b.completionDate));
}

// ------------------------------------------------------------- monthly P&L
export interface MonthPnl {
  month: string;                 // YYYY-MM
  label: string;                 // "Jan 2026"
  income: number; cogs: number; grossProfit: number; expenses: number; netOperatingIncome: number; netProfit: number;
  deals: number;                 // CRM projects completed in the month
  avgGross: number | null; gpPct: number | null; avgNet: number | null; npPct: number | null; aov: number | null;
}
export type PnlTotal = Omit<MonthPnl, "month" | "label"> & { label: "Total" };
export interface MonthlyPnlReport {
  year: number;
  source: "QuickBooks ProfitAndLoss by Month (accrual)";
  months: MonthPnl[];
  total: PnlTotal;
  // The bookkeeper's method: sum of the per-class (per-project) P&Ls of the projects completed in each month.
  delivered: MonthPnl[];
  deliveredTotal: PnlTotal;
  deliveredSource: "QuickBooks ProfitAndLoss?class for projects completed in the month (CRM completion dates)";
  fetchedAt: string;
}

export function monthFromSummary(month: string, s: PnlSummary, deals: number): MonthPnl {
  return {
    month, label: monthLabel(month), income: s.income, cogs: s.cogs, grossProfit: s.grossProfit, expenses: s.expenses, netOperatingIncome: s.netOperatingIncome, netProfit: s.netIncome,
    deals, avgGross: avg(s.grossProfit, deals), gpPct: pct(s.grossProfit, s.income), avgNet: avg(s.netIncome, deals), npPct: pct(s.netIncome, s.income), aov: avg(s.income, deals),
  };
}
export function totalOf(months: MonthPnl[]): PnlTotal {
  const sum = (k: keyof MonthPnl) => r2(months.reduce((s, x) => s + (Number(x[k]) || 0), 0));
  const deals = months.reduce((s, x) => s + x.deals, 0);
  return { label: "Total" as const, income: sum("income"), cogs: sum("cogs"), grossProfit: sum("grossProfit"), expenses: sum("expenses"), netOperatingIncome: sum("netOperatingIncome"), netProfit: sum("netProfit"), deals, avgGross: avg(sum("grossProfit"), deals), gpPct: pct(sum("grossProfit"), sum("income")), avgNet: avg(sum("netProfit"), deals), npPct: pct(sum("netProfit"), sum("income")), aov: avg(sum("income"), deals) };
}

// Month columns of a by-month report → MonthPnl rows (exported for tests).
export function monthsFromParsed(parsed: ParsedPnl, year: number, dealsByMonth: Record<string, number> = {}): MonthPnl[] {
  const months: MonthPnl[] = [];
  for (let m = 1; m <= 12; m++) {
    const month = `${year}-${String(m).padStart(2, "0")}`;
    const col = parsed.columns.findIndex((c) => (c.start && monthKeyOf(c.start) === month) || new RegExp(`^${MONTHS[m - 1]}\\w*\\s+${year}$`, "i").test(c.title));
    const s = col >= 0 ? summariseColumn(parsed, col) : emptySummary();
    months.push(monthFromSummary(month, s, dealsByMonth[month] || 0));
  }
  return months;
}

// Delivered-projects P&L per month (the per-class method).
export async function deliveredMonthlyPnl(year: number, opts: { fresh?: boolean } = {}): Promise<MonthPnl[]> {
  const completed = await completedProjects().catch(() => [] as CompletedProject[]);
  const out: MonthPnl[] = [];
  for (let m = 1; m <= 12; m++) {
    const month = `${year}-${String(m).padStart(2, "0")}`;
    if (!completed.some((p) => monthKeyOf(p.completionDate) === month)) { out.push(monthFromSummary(month, emptySummary(), 0)); continue; }
    try {
      const rep = await classPnlForProjects(month, { fresh: opts.fresh });
      const matched = rep.designers.reduce((n, d) => n + d.projects.filter((p) => p.pnl).length, 0);
      out.push(monthFromSummary(month, rep.total, matched));
    } catch { out.push(monthFromSummary(month, emptySummary(), 0)); }
  }
  return out;
}

export async function monthlyPnl(year: number, opts: { fresh?: boolean } = {}): Promise<MonthlyPnlReport> {
  const store = financeStore();
  const key = `PNL_MONTHLY#${year}`;
  const thisYear = Number(localDate().slice(0, 4));
  if (!opts.fresh) {
    const row = await store.get<MonthlyPnlReport>(company(), key).catch(() => null);
    const age = row ? Date.now() - Date.parse(row.data.fetchedAt) : Infinity;
    if (row && (year < thisYear ? age < 7 * 86_400_000 : age < 6 * 3_600_000)) return row.data;
  }
  const api = await qboClient();
  const raw = await api.get(`/reports/ProfitAndLoss?start_date=${year}-01-01&end_date=${year}-12-31&summarize_column_by=Month&accounting_method=Accrual`);
  const parsed = parseProfitAndLoss(raw);
  const completed = await completedProjects().catch(() => [] as CompletedProject[]);
  const dealsByMonth: Record<string, number> = {};
  for (const p of completed) { const k = monthKeyOf(p.completionDate); dealsByMonth[k] = (dealsByMonth[k] || 0) + 1; }
  const months = monthsFromParsed(parsed, year, dealsByMonth);
  const delivered = await deliveredMonthlyPnl(year, { fresh: opts.fresh }).catch(() => [] as MonthPnl[]);
  const report: MonthlyPnlReport = { year, source: "QuickBooks ProfitAndLoss by Month (accrual)", months, total: totalOf(months), delivered, deliveredTotal: totalOf(delivered), deliveredSource: "QuickBooks ProfitAndLoss?class for projects completed in the month (CRM completion dates)", fetchedAt: new Date().toISOString() };
  const existing = await store.get<MonthlyPnlReport>(company(), key).catch(() => null);
  await store.transact(company(), [{ key, expected: existing?.version ?? null, data: report }]).catch(() => {});
  return report;
}

// ------------------------------------------------------------ class P&L
export interface ClassPnlRow { label: string; kind: PnlFlatRow["kind"]; depth: number; group: string | null; amount: number; pctOfIncome: number | null }
export interface ClassPnl {
  classId: string;
  className: string | null;
  start: string;
  end: string;
  rows: ClassPnlRow[];
  summary: PnlSummary;
  source: "QuickBooks ProfitAndLoss?class";
  fetchedAt: string;
}

export async function classPnl(classId: string, range: { start?: string; end?: string; cacheMonth?: string; fresh?: boolean } = {}): Promise<ClassPnl> {
  const start = range.start || "2015-01-01";
  const end = range.end || localDate();
  const cacheMonth = range.cacheMonth || null;
  const store = financeStore();
  const key = cacheMonth ? `PNL_CLASS#${classId}#${cacheMonth}` : null;
  if (key && !range.fresh) {
    const row = await store.get<ClassPnl>(company(), key).catch(() => null);
    if (row && row.data.start === start) {
      const closed = cacheMonth! < currentMonth();
      const age = Date.now() - Date.parse(row.data.fetchedAt);
      // A closed month can still move (late bills) — refresh weekly; current month daily.
      if (closed ? age < 7 * 86_400_000 : age < 24 * 3_600_000) return row.data;
    }
  }
  const api = await qboClient();
  const raw = await api.get(`/reports/ProfitAndLoss?class=${encodeURIComponent(classId)}&start_date=${start}&end_date=${end}&accounting_method=Accrual`);
  const parsed = parseProfitAndLoss(raw);
  const summary = summariseColumn(parsed, 0);
  const ref = await qboRefData().catch(() => null);
  const rows: ClassPnlRow[] = parsed.rows.map((r) => ({ label: r.label, kind: r.kind, depth: r.depth, group: r.group, amount: r.values[0] ?? 0, pctOfIncome: r.kind === "header" ? null : pct(r.values[0] ?? 0, summary.income) }));
  const report: ClassPnl = { classId, className: ref?.classes.find((c) => c.id === classId)?.name ?? null, start, end, rows, summary, source: "QuickBooks ProfitAndLoss?class", fetchedAt: new Date().toISOString() };
  if (key) {
    const existing = await store.get<ClassPnl>(company(), key).catch(() => null);
    await store.transact(company(), [{ key, expected: existing?.version ?? null, data: report }]).catch(() => {});
  }
  return report;
}

export async function classPnlByCustomer(customer: string, range: { start?: string; end?: string } = {}): Promise<ClassPnl & { matched: QboRef; candidates: QboRef[] }> {
  const ref = await qboRefData();
  const hits = classByCustomer(ref, customer);
  if (!hits.length) throw new FinanceError(`CLASS_NOT_FOUND: no QuickBooks class matches "${customer}"`, false, 404);
  if (hits.length > 1) throw new FinanceError(`CLASS_AMBIGUOUS: ${hits.map((h) => `${h.name} (#${h.id})`).join(", ")}`, false, 409);
  const r = await classPnl(hits[0].id, range);
  return { ...r, matched: hits[0], candidates: hits };
}

// ------------------------------------------- class P&L for a month's deliveries
export interface ProjectClassPnl {
  projectId: string;
  client: string;
  designer: string;
  completionDate: string;
  completionSource: CompletionSource;
  classId: string | null;
  className: string | null;
  ambiguous: QboRef[];           // >1 class matched the customer name — not resolved
  pnl: ClassPnl | null;
  error: string | null;
  hasFinalInvoice: boolean;
  remedialsOpen: boolean;
  wonValue: number;
  wonDate: string | null;
}
export interface MonthClassPnl {
  month: string;
  label: string;
  designers: { designer: string; projects: ProjectClassPnl[]; total: PnlSummary }[];
  rowOrder: { label: string; kind: PnlFlatRow["kind"]; depth: number }[];   // merged row set in QuickBooks order
  total: PnlSummary;
  unmatched: number;
  fetchedAt: string;
}

// Merge each report's row list into one ordered set (QuickBooks omits zero rows per class).
export function mergeRowOrder(reports: ClassPnl[]): MonthClassPnl["rowOrder"] {
  const order: MonthClassPnl["rowOrder"] = [];
  const idx = (label: string) => order.findIndex((o) => o.label === label);
  for (const rep of [...reports].sort((a, b) => b.rows.length - a.rows.length)) {
    let last = -1;
    for (const r of rep.rows) {
      const i = idx(r.label);
      if (i >= 0) { last = Math.max(last, i); continue; }
      order.splice(last + 1, 0, { label: r.label, kind: r.kind, depth: r.depth });
      last = last + 1;
    }
  }
  return order;
}

export async function classPnlForProjects(month: string, opts: { fresh?: boolean; designer?: string } = {}): Promise<MonthClassPnl> {
  const [projects, ref] = await Promise.all([completedProjects(month), qboRefData().catch(() => null)]);
  const out: ProjectClassPnl[] = [];
  for (const p of projects) {
    if (opts.designer && !matchesDesigner(p, opts.designer)) continue;
    const hits = ref ? classByCustomer(ref, p.client) : [];
    const base: ProjectClassPnl = { projectId: p.projectId, client: p.client, designer: p.designer, completionDate: p.completionDate, completionSource: p.completionSource, classId: null, className: null, ambiguous: [], pnl: null, error: null, hasFinalInvoice: p.hasFinalInvoice, remedialsOpen: p.remedialsOpen, wonValue: p.wonValue, wonDate: p.wonDate };
    if (!ref) { out.push({ ...base, error: "QuickBooks reference data unavailable" }); continue; }
    if (hits.length === 0) { out.push({ ...base, error: "No QuickBooks class matches this customer" }); continue; }
    if (hits.length > 1) { out.push({ ...base, ambiguous: hits, error: `Ambiguous class: ${hits.map((h) => h.name).join(" / ")}` }); continue; }
    try {
      const pnl = await classPnl(hits[0].id, { cacheMonth: month, fresh: opts.fresh });
      out.push({ ...base, classId: hits[0].id, className: hits[0].name, pnl });
    } catch (e) {
      out.push({ ...base, classId: hits[0].id, className: hits[0].name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const byDesigner = new Map<string, ProjectClassPnl[]>();
  for (const p of out) byDesigner.set(p.designer, [...(byDesigner.get(p.designer) || []), p]);
  const designers = Array.from(byDesigner.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([designer, ps]) => ({ designer, projects: ps, total: ps.reduce((s, p) => (p.pnl ? addSummary(s, p.pnl.summary) : s), emptySummary()) }));
  return {
    month, label: monthLabel(month), designers,
    rowOrder: mergeRowOrder(out.map((p) => p.pnl).filter((x): x is ClassPnl => !!x)),
    total: designers.reduce((s, d) => addSummary(s, d.total), emptySummary()),
    unmatched: out.filter((p) => !p.pnl).length,
    fetchedAt: new Date().toISOString(),
  };
}

// A designer fragment matches the display name or the CRM designer field.
export function matchesDesigner(p: { designer: string; project?: Pick<Project, "designer"> }, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return false;
  return p.designer.toLowerCase().includes(n) || (p.project?.designer || "").toLowerCase().includes(n);
}
