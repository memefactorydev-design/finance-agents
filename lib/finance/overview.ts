// The finance overview — the project money model rolled up across every
// active project: payment schedules, invoices, collections and the four
// P&Ls. CRM figures are operational projections, not bank or ledger
// verification (source: CRM_UNRECONCILED). Shared by the API, the cashflow
// outlook and the MCP tools.
import { r2 } from "@/lib/core/domain";
import { getConnections } from "@/lib/core/config";
import { localDate, shiftDays } from "@/lib/core/text";
import { listProjects } from "@/lib/crm/projects";
import { contractGross, contractNet, invoiceTotal, paymentsTaken, resolveSchedule, scheduleTotals, type FinanceDefaults, type ResolvedLine } from "@/lib/crm/schedule";
import { projectName, type Invoice, type PaymentConfirmation, type Project } from "@/lib/crm/types";
import { paymentRecordedFor } from "./invoices";
import { ledgerCostsByClass, projectLedgerCosts, supplierAliasIndex, type LedgerCostsByClass, type SupplierAliasIndex } from "./ledger";
import { pnlComparison, type PnlComparison } from "./project-pnl";
import { listSupplierProfiles } from "./suppliers";

export type DueWindow = "overdue" | "next7" | "next14" | "next30" | "all";

export interface DueLine {
  projectId: string;
  client: string;
  designer: string | null;
  opsStage: string | null;
  key: ResolvedLine["key"];
  label: string;
  group: ResolvedLine["group"];
  amountGross: number;
  outstandingGross: number;
  dueDate: string | null;
  status: ResolvedLine["status"];
  invoiceNumber: string | null;
  invoiceStatus: Invoice["status"] | null;
}
export interface CollectionRow {
  projectId: string;
  client: string;
  designer: string | null;
  opsStage: string | null;
  wonDate: string | null;
  net: number;
  gross: number;
  taken: number;
  outstanding: number;
  overdue: number;
  nextDue: DueLine | null;
  invoices: { total: number; paid: number; sent: number; draft: number };
  lines: ResolvedLine[];
}
export interface InvoiceRow {
  projectId: string;
  client: string;
  designer: string | null;
  invoice: Invoice;
  gross: number;
  lineLabel: string | null;
  overdue: boolean;
  confirmation: PaymentConfirmation | null; // how the receipt was verified (paid invoices)
}
export interface PnlRow { projectId: string; client: string; designer: string | null; opsStage: string | null; net: number; comparison: PnlComparison }

export interface FinanceOverview {
  generatedAt: string;
  defaults: FinanceDefaults;
  projects: number;
  source: "CRM_UNRECONCILED";
  pnlCoverage: { eligible: number; loaded: number; truncated: boolean; ledgerAvailable: boolean };
  kpis: {
    contractNet: number;
    contractGross: number;
    taken: number;
    outstanding: number;
    overdue: number;
    dueNext14: number;
    dueNext30: number;
    uninvoicedDue: number;       // gross of lines that are due/overdue but have no invoice yet
    invoices: { draft: { count: number; value: number }; sent: { count: number; value: number }; paid: { count: number; value: number } };
    pnl: {
      salesProfit: number; salesMargin: number | null; salesCount: number;
      orderProfit: number; orderMargin: number | null; orderCount: number;
      supplierProfit: number; supplierMargin: number | null; supplierCount: number;
      completionProfit: number; completionMargin: number | null; completionCount: number;
    };
  };
  collections: CollectionRow[];
  dueLines: DueLine[];
  invoices: InvoiceRow[];
  pnl: PnlRow[];
}

export const portfolioMargin = (profit: number, revenue: number): number | null => (revenue > 0 ? Math.round((profit / revenue) * 10000) / 100 : null);

export function inWindow(line: { dueDate: string | null; status: string }, window: DueWindow, base = localDate()): boolean {
  if (line.status === "paid" || line.status === "n/a") return false;
  if (window === "all") return true;
  if (window === "overdue") return line.status === "overdue";
  if (!line.dueDate) return false;
  const days = window === "next7" ? 7 : window === "next14" ? 14 : 30;
  return line.dueDate >= base && line.dueDate <= shiftDays(base, days);
}

export interface OverviewOptions {
  includeCompleted?: boolean;  // completed projects too (retention, late invoices)
  includeCancelled?: boolean;
  pnlLimit?: number;           // projects to run the four P&Ls for
  ledger?: null;               // null = skip the QuickBooks ledger read (Completion shows "unavailable")
  ledgerTimeoutMs?: number;
}

export async function buildFinanceOverview(opts: OverviewOptions = {}): Promise<FinanceOverview> {
  const cfg = await getConnections();
  const defaults: FinanceDefaults = cfg.company.finance;
  const all = opts.includeCompleted || opts.includeCancelled ? await listProjects({ status: "all", includeCancelled: !!opts.includeCancelled }) : await listProjects({ status: "active" });
  const projects = all.filter((p) => p.status === "active" || (opts.includeCompleted && p.status === "completed") || (opts.includeCancelled && p.status === "cancelled"));
  const base = localDate();

  const collections: CollectionRow[] = [];
  const dueLines: DueLine[] = [];
  const invoices: InvoiceRow[] = [];
  const kpis: FinanceOverview["kpis"] = {
    contractNet: 0, contractGross: 0, taken: 0, outstanding: 0, overdue: 0, dueNext14: 0, dueNext30: 0, uninvoicedDue: 0,
    invoices: { draft: { count: 0, value: 0 }, sent: { count: 0, value: 0 }, paid: { count: 0, value: 0 } },
    pnl: { salesProfit: 0, salesMargin: 0, salesCount: 0, orderProfit: 0, orderMargin: 0, orderCount: 0, supplierProfit: 0, supplierMargin: 0, supplierCount: 0, completionProfit: 0, completionMargin: 0, completionCount: 0 },
  };

  for (const p of projects) {
    const lines = resolveSchedule(p, { defaults, today: base });
    const totals = scheduleTotals(lines);
    const gross = contractGross(p, defaults);
    const net = contractNet(p);
    const taken = paymentsTaken(p.payments);
    const outstanding = Math.max(0, r2(gross - taken));
    const client = projectName(p);
    const designer = p.designer || null;
    const projectDue: DueLine[] = lines
      .filter((l) => l.applicable && l.status !== "paid" && l.amountGross > 0)
      .map((l) => ({ projectId: p.id, client, designer, opsStage: p.opsStage || null, key: l.key, label: l.label, group: l.group, amountGross: l.amountGross, outstandingGross: l.outstandingGross, dueDate: l.dueDate, status: l.status, invoiceNumber: l.invoice?.number || null, invoiceStatus: l.invoice?.status || null }));
    dueLines.push(...projectDue);
    const nextDue = [...projectDue].sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"))[0] || null;

    const invCounts = { total: 0, paid: 0, sent: 0, draft: 0 };
    for (const inv of p.invoices || []) {
      if (inv.status === "void") continue;
      const total = invoiceTotal(inv);
      invCounts.total += 1;
      if (inv.status === "paid") invCounts.paid += 1; else if (inv.status === "sent") invCounts.sent += 1; else invCounts.draft += 1;
      const bucket = inv.status === "paid" ? "paid" : inv.status === "sent" ? "sent" : "draft";
      kpis.invoices[bucket].count += 1;
      kpis.invoices[bucket].value = r2(kpis.invoices[bucket].value + total);
      const line = inv.scheduleKey ? lines.find((l) => l.key === inv.scheduleKey) : null;
      invoices.push({ projectId: p.id, client, designer, invoice: inv, gross: total, lineLabel: line?.label || null, overdue: inv.status !== "paid" && !!inv.dueDate && inv.dueDate.slice(0, 10) < base, confirmation: inv.status === "paid" ? (p.payments || []).find((x) => paymentRecordedFor(inv, x))?.confirmation ?? null : null });
    }
    collections.push({ projectId: p.id, client, designer, opsStage: p.opsStage || null, wonDate: p.wonDate, net, gross, taken, outstanding, overdue: totals.overdueGross, nextDue, invoices: invCounts, lines });

    kpis.contractNet = r2(kpis.contractNet + net);
    kpis.contractGross = r2(kpis.contractGross + gross);
    kpis.taken = r2(kpis.taken + taken);
    kpis.outstanding = r2(kpis.outstanding + outstanding);
    kpis.overdue = r2(kpis.overdue + totals.overdueGross);
    for (const l of projectDue) {
      if (inWindow(l, "next14", base)) kpis.dueNext14 = r2(kpis.dueNext14 + l.outstandingGross);
      if (inWindow(l, "next30", base)) kpis.dueNext30 = r2(kpis.dueNext30 + l.outstandingGross);
      if ((l.status === "due" || l.status === "overdue") && !l.invoiceNumber) kpis.uninvoicedDue = r2(kpis.uninvoicedDue + l.outstandingGross);
    }
  }

  // P&L: active projects, newest won first. The Completion P&L reads the
  // supplier invoices posted to each project's QuickBooks class — one cached
  // ledger read serves every project; when QuickBooks is unreachable the
  // stage shows "ledger unavailable".
  const eligible = projects.filter((p) => p.status === "active").sort((a, b) => (b.wonDate || "").localeCompare(a.wonDate || ""));
  const active = eligible.slice(0, opts.pnlLimit ?? 150);
  const ledgerRead: Promise<LedgerCostsByClass | undefined> = opts.ledger === null
    ? Promise.resolve(undefined)
    : Promise.race([ledgerCostsByClass().catch(() => undefined), new Promise<undefined>((res) => setTimeout(() => res(undefined), opts.ledgerTimeoutMs ?? 8_000))]);
  const [ledger, aliases] = await Promise.all([ledgerRead, opts.ledger === null ? Promise.resolve(undefined) : listSupplierProfiles().then(supplierAliasIndex).catch(() => undefined as SupplierAliasIndex | undefined)]);

  const pnl: PnlRow[] = [];
  let sm = 0, om = 0, spm = 0, cm = 0;
  for (const p of active) {
    const comparison = pnlComparison(p, p.supplierOrders || [], projectLedgerCosts(p, ledger), { aliases });
    if (!comparison.sales.available && !comparison.order.available && !comparison.completion.available) continue;
    pnl.push({ projectId: p.id, client: projectName(p), designer: p.designer || null, opsStage: p.opsStage || null, net: p.wonValue || 0, comparison });
    if (comparison.sales.available) { kpis.pnl.salesCount += 1; kpis.pnl.salesProfit = r2(kpis.pnl.salesProfit + comparison.sales.profit); sm += comparison.sales.revenue; }
    if (comparison.order.available) { kpis.pnl.orderCount += 1; kpis.pnl.orderProfit = r2(kpis.pnl.orderProfit + comparison.order.profit); om += comparison.order.revenue; }
    if (comparison.supplier.available) { kpis.pnl.supplierCount += 1; kpis.pnl.supplierProfit = r2(kpis.pnl.supplierProfit + comparison.supplier.profit); spm += comparison.supplier.revenue; }
    if (comparison.completion.available) { kpis.pnl.completionCount += 1; kpis.pnl.completionProfit = r2(kpis.pnl.completionProfit + comparison.completion.profit); cm += comparison.completion.revenue; }
  }
  kpis.pnl.salesMargin = portfolioMargin(kpis.pnl.salesProfit, sm);
  kpis.pnl.orderMargin = portfolioMargin(kpis.pnl.orderProfit, om);
  kpis.pnl.supplierMargin = portfolioMargin(kpis.pnl.supplierProfit, spm);
  kpis.pnl.completionMargin = portfolioMargin(kpis.pnl.completionProfit, cm);

  collections.sort((a, b) => b.outstanding - a.outstanding);
  dueLines.sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
  invoices.sort((a, b) => (b.invoice.date || "").localeCompare(a.invoice.date || ""));
  return { generatedAt: new Date().toISOString(), defaults, projects: projects.length, source: "CRM_UNRECONCILED", pnlCoverage: { eligible: eligible.length, loaded: active.length, truncated: active.length < eligible.length, ledgerAvailable: !!ledger }, kpis, collections, dueLines, invoices, pnl };
}

// Slim shape for agents / list views (no schedule line arrays).
export function slimOverview(o: FinanceOverview) {
  return {
    generatedAt: o.generatedAt,
    projects: o.projects,
    source: o.source,
    pnlCoverage: o.pnlCoverage,
    kpis: o.kpis,
    topOutstanding: o.collections.slice(0, 10).map(({ lines: _l, ...row }) => row),
    overdue: o.dueLines.filter((l) => l.status === "overdue"),
    dueNext14: o.dueLines.filter((l) => inWindow(l, "next14")),
  };
}
export type { Project };
