// Designer commission engine. Tier tables, the minimum-sales gate and the
// payable-now / payable-later split live in CONFIG#commission (finance
// store). Nothing is seeded: every designer is added with set_commission_config
// (or the API) — a designer without a tier table gets a statement that shows
// profit only and is flagged.
//
// Profit per project = Net Operating Income of the QuickBooks P&L filtered to
// the project's class. When no class matches, the CRM Completion P&L is used
// and the row is flagged source:"crm". Tier lookup is a floor: the highest
// threshold ≤ profit%; below the lowest tier pays 0. Every input is returned
// so the statement can be checked line by line. Nothing here pays anyone —
// the agent prepares, the owner approves.
import { FinanceError, r2 } from "@/lib/core/domain";
import { company, financeStore } from "@/lib/core/server";
import { getProject, listProjects } from "@/lib/crm/projects";
import { projectName } from "@/lib/crm/types";
import { classPnlForProjects, monthLabel, shiftMonth, type ProjectClassPnl } from "./qbo-pnl";
import { projectPnl } from "./project-pnl";

export type Tier = [threshold: number, commPct: number];

export interface DesignerCommission {
  key: string;                   // short handle, e.g. "ab"
  displayName: string;
  match: string[];               // substrings matched against the CRM designer field (case-insensitive)
  tiers: Tier[] | null;          // null = structure unknown (statement shows profit only)
  minSalesPerMonth: number | null;
  split: { now: number; later: number };  // percentages, sum 100
  laterRule: string;
  notes: string;
}
export interface CommissionConfig { designers: Record<string, DesignerCommission>; updatedBy: string; updatedAt: string; seeded: boolean }

export const COMMISSION_KEY = "CONFIG#commission";
export const DEFAULT_COMMISSION: CommissionConfig = { designers: {}, updatedBy: "default", updatedAt: "1970-01-01T00:00:00.000Z", seeded: true };

export async function getCommissionConfig(): Promise<CommissionConfig> {
  const row = await financeStore().get<CommissionConfig>(company(), COMMISSION_KEY);
  return row?.data?.designers ? row.data : DEFAULT_COMMISSION;
}

export interface CommissionPatch { designer: string; displayName?: string; match?: string[]; tiers?: Tier[] | null; split?: { now: number; later: number }; minSalesPerMonth?: number | null; laterRule?: string; notes?: string }

export async function setCommissionConfig(patch: CommissionPatch, by: string): Promise<CommissionConfig> {
  const key = patch.designer.trim().toLowerCase();
  if (!key) throw new FinanceError("COMMISSION_DESIGNER_REQUIRED", false, 422);
  if (patch.tiers) for (const t of patch.tiers) if (!Array.isArray(t) || t.length !== 2 || !Number.isFinite(t[0]) || !Number.isFinite(t[1]) || t[1] < 0 || t[1] > 100) throw new FinanceError("COMMISSION_TIERS_INVALID", false, 422);
  if (patch.split && Math.round(patch.split.now + patch.split.later) !== 100) throw new FinanceError("COMMISSION_SPLIT_MUST_SUM_100", false, 422);
  const store = financeStore();
  const row = await store.get<CommissionConfig>(company(), COMMISSION_KEY);
  const current = row?.data?.designers ? row.data : DEFAULT_COMMISSION;
  const existing = current.designers[key] || { key, displayName: patch.displayName || key.replace(/\b\w/g, (c) => c.toUpperCase()), match: [key], tiers: null, minSalesPerMonth: null, split: { now: 100, later: 0 }, laterRule: "", notes: "" };
  const next: DesignerCommission = {
    ...existing,
    ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
    ...(patch.match !== undefined ? { match: patch.match.map((m) => m.toLowerCase()) } : {}),
    ...(patch.tiers !== undefined ? { tiers: patch.tiers ? [...patch.tiers].sort((a, b) => a[0] - b[0]) : null } : {}),
    ...(patch.split !== undefined ? { split: patch.split } : {}),
    ...(patch.minSalesPerMonth !== undefined ? { minSalesPerMonth: patch.minSalesPerMonth } : {}),
    ...(patch.laterRule !== undefined ? { laterRule: patch.laterRule } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
  };
  const cfg: CommissionConfig = { ...current, designers: { ...current.designers, [key]: next }, updatedBy: by, updatedAt: new Date().toISOString(), seeded: false };
  await store.transact(company(), [{ key: COMMISSION_KEY, expected: row?.version ?? null, data: cfg }]);
  return cfg;
}

// Floor lookup: the highest threshold ≤ profit%; below the lowest tier → 0.
export function tierPct(tiers: Tier[] | null, profitPct: number | null): number | null {
  if (!tiers || profitPct == null) return null;
  const sorted = [...tiers].sort((a, b) => a[0] - b[0]);
  let pct = 0;
  for (const [threshold, comm] of sorted) if (profitPct >= threshold) pct = comm;
  return pct;
}

export function resolveDesigner(cfg: CommissionConfig, designer: string): DesignerCommission {
  const n = designer.trim().toLowerCase();
  const byKey = cfg.designers[n];
  if (byKey) return byKey;
  const hit = Object.values(cfg.designers).find((d) => d.match.some((m) => n.includes(m) || m.includes(n)) || d.displayName.toLowerCase() === n);
  if (!hit) throw new FinanceError(`COMMISSION_DESIGNER_UNKNOWN: ${designer} (known: ${Object.keys(cfg.designers).join(", ") || "none — add one with set_commission_config"})`, false, 404);
  return hit;
}
const designerMatches = (d: DesignerCommission, value: string | null | undefined) => { const v = (value || "").toLowerCase(); return !!v && d.match.some((m) => v.includes(m)); };

// -------------------------------------------------------------- statement
export type CommissionHold = "no_final_invoice" | "remedials_open" | "below_lowest_tier" | "class_not_matched" | "class_ambiguous" | "no_profit_data" | "tiers_unknown";

export interface CommissionProject {
  projectId: string;
  client: string;
  classId: string | null;
  className: string | null;
  completionDate: string;
  completionSource: ProjectClassPnl["completionSource"];
  source: "qbo_class" | "crm";
  income: number | null;
  profit: number | null;           // Net Operating Income (QuickBooks) or Completion profit (CRM)
  profitPct: number | null;
  commPct: number | null;
  commission: number | null;
  payableNow: number | null;
  payableLater: number | null;
  payableLaterDate: string | null; // completion + 1 month
  holds: CommissionHold[];
  notes: string[];
}
export interface CommissionStatement {
  designer: DesignerCommission;
  month: string;
  label: string;
  tiersSource: "CONFIG#commission" | "unknown";
  projects: CommissionProject[];
  totals: { income: number; profit: number; commission: number; payableNow: number; payableLater: number; projects: number; withHolds: number; profitPct: number | null };
  minSalesGate: { required: number | null; achieved: number; met: boolean; salesInMonth: { projectId: string; client: string; wonDate: string | null; wonValue: number }[] };
  generatedAt: string;
}

export const addMonth = (iso: string) => {
  const d = new Date(iso + "T00:00:00Z");
  const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
};

async function crmCompletionProfit(projectId: string): Promise<{ income: number; profit: number; profitPct: number | null; source: string } | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  const cmp = await projectPnl(project);
  if (!cmp.completion.available) return null;
  return { income: cmp.completion.revenue, profit: cmp.completion.profit, profitPct: cmp.completion.revenue > 0 ? r2((cmp.completion.profit / cmp.completion.revenue) * 100) : null, source: cmp.completion.source || "CRM completion P&L" };
}

// Pure statement line (exported for tests): one completed project through
// the tier table, the split and the holds.
export function commissionLine(designer: DesignerCommission, p: Pick<ProjectClassPnl, "projectId" | "client" | "classId" | "className" | "completionDate" | "completionSource" | "hasFinalInvoice" | "remedialsOpen" | "ambiguous" | "error">, figures: { income: number; profit: number; source: CommissionProject["source"]; note: string } | null): CommissionProject {
  const holds: CommissionHold[] = [];
  const notes: string[] = [];
  const lowest = designer.tiers ? Math.min(...designer.tiers.map((t) => t[0])) : null;
  let income: number | null = null, profit: number | null = null, profitPct: number | null = null;
  let source: CommissionProject["source"] = "qbo_class";
  if (figures) { income = figures.income; profit = figures.profit; profitPct = income > 0 ? r2((profit / income) * 100) : null; source = figures.source; notes.push(figures.note); }
  if (!figures || figures.source === "crm") { if (p.ambiguous.length) holds.push("class_ambiguous"); else holds.push("class_not_matched"); if (p.error) notes.push(p.error); }
  if (!figures) { holds.push("no_profit_data"); notes.push("No QuickBooks class and no CRM completion P&L — profit unknown"); }
  if (!p.hasFinalInvoice) holds.push("no_final_invoice");
  if (p.remedialsOpen) holds.push("remedials_open");
  if (!designer.tiers) holds.push("tiers_unknown");
  if (lowest != null && profitPct != null && profitPct < lowest) holds.push("below_lowest_tier");
  if (p.completionSource === "fallback") notes.push("Completion date inferred (no Stage 2 date stamped) — confirm");
  const commPct = tierPct(designer.tiers, profitPct);
  const commission = commPct != null && profit != null ? r2(Math.max(0, profit) * commPct / 100) : null;
  const payableNow = commission != null ? r2(commission * designer.split.now / 100) : null;
  const payableLater = commission != null ? r2(commission - payableNow!) : null;
  return { projectId: p.projectId, client: p.client, classId: p.classId, className: p.className, completionDate: p.completionDate, completionSource: p.completionSource, source, income, profit, profitPct, commPct, commission, payableNow, payableLater, payableLaterDate: payableLater ? addMonth(p.completionDate) : null, holds, notes };
}

export async function commissionStatement(input: { designer: string; month: string; fresh?: boolean }): Promise<CommissionStatement> {
  if (!/^\d{4}-\d{2}$/.test(input.month)) throw new FinanceError("MONTH_FORMAT_YYYY_MM", false, 422);
  const cfg = await getCommissionConfig();
  const designer = resolveDesigner(cfg, input.designer);
  const monthPnl = await classPnlForProjects(input.month, { fresh: input.fresh });
  const mine = monthPnl.designers.flatMap((d) => d.projects).filter((p) => designerMatches(designer, p.designer));
  const projects: CommissionProject[] = [];
  for (const p of mine) {
    if (p.pnl) { projects.push(commissionLine(designer, p, { income: p.pnl.summary.income, profit: p.pnl.summary.netOperatingIncome, source: "qbo_class", note: `QuickBooks P&L by class "${p.className}" (${p.pnl.start} → ${p.pnl.end})` })); continue; }
    const crm = await crmCompletionProfit(p.projectId).catch(() => null);
    projects.push(commissionLine(designer, p, crm ? { income: crm.income, profit: crm.profit, source: "crm", note: `Fallback: CRM Completion P&L (${crm.source}) — net of VAT, unreconciled` } : null));
  }
  const sum = (f: (p: CommissionProject) => number | null) => r2(projects.reduce((s, p) => s + (f(p) ?? 0), 0));
  const income = sum((p) => p.income), profit = sum((p) => p.profit);
  const totals = { income, profit, commission: sum((p) => p.commission), payableNow: sum((p) => p.payableNow), payableLater: sum((p) => p.payableLater), projects: projects.length, withHolds: projects.filter((p) => p.holds.length).length, profitPct: income > 0 ? r2((profit / income) * 100) : null };

  // Minimum-sales gate: jobs WON by this designer in the month.
  const won = await listProjects({ status: "all" }).catch(() => []);
  const salesInMonth = won
    .filter((p) => p.status !== "lost" && p.status !== "cancelled" && (p.wonDate || "").slice(0, 7) === input.month && designerMatches(designer, p.designer))
    .map((p) => ({ projectId: p.id, client: projectName(p), wonDate: p.wonDate, wonValue: p.wonValue || 0 }));
  const required = designer.minSalesPerMonth;
  return {
    designer, month: input.month, label: monthLabel(input.month),
    tiersSource: designer.tiers ? "CONFIG#commission" : "unknown",
    projects, totals,
    minSalesGate: { required, achieved: salesInMonth.length, met: required == null || salesInMonth.length >= required, salesInMonth },
    generatedAt: new Date().toISOString(),
  };
}

// Months the commission tabs show: the two previous months plus the current one.
export function commissionMonths(current: string, count = 3): string[] {
  return Array.from({ length: count }, (_, i) => shiftMonth(current, -(count - 1 - i)));
}
