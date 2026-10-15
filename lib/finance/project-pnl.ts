// The four P&Ls of one project (all NET of VAT):
//   Sales      — the contract value vs the sales-stage costing snapshot
//                (project.costing.sales, frozen by the CRM at the sale)
//   Order      — contract + add-on sell vs the survey-order costing
//                (project.costing.order when the CRM froze one; live from the
//                supplier purchase orders until then)
//   Supplier   — the same orders at the SUPPLIER-ACKNOWLEDGED cost (their
//                prices, carriage and surcharges; ordered prices where no
//                acknowledgement yet) — always live, never snapshotted
//   Completion — contract + add-on sell vs what the suppliers ACTUALLY
//                INVOICED (QuickBooks bills / credits / purchases posted to the
//                project's class) plus manual extras. Shown only once every
//                supplier on the project has invoiced; "awaiting" before.
// Pure functions plus one loader (projectPnl) that pulls the ledger and the
// supplier aliases. Shared by the overview, the commission engine, the
// MCP tools and the tests.
import { r2 } from "@/lib/core/domain";
import { gbp2 } from "@/lib/crm/schedule";
import { orderedCost, type CostStageSummary, type ExtraCost, type Project, type SupplierOrder } from "@/lib/crm/types";
import { completionCutoff } from "./qbo-pnl";
import { ledgerCostsByClass, projectLedgerCosts, supplierAliasIndex, vendorMatches, type ProjectLedger, type SupplierAliasIndex } from "./ledger";
import { listSupplierProfiles } from "./suppliers";
export type { ProjectLedger, SupplierAliasIndex } from "./ledger";

export type PnlStage = "sales" | "order" | "supplier" | "completion";

export interface Pnl {
  stage: PnlStage;
  available: boolean;     // false = nothing to show yet
  frozen: boolean;        // true = from a stored snapshot
  capturedAt?: string;
  source?: string;        // e.g. "sales costing snapshot" / "3 supplier orders (live)"
  salePrice: number;
  addonSell: number;
  revenue: number;
  breakdown: { contract: number; addon: number; remedial: number; extra: number };
  cost: number;
  profit: number;
  marginPct: number;
  warnings: string[];
}

export function computePnl(input: { stage: PnlStage; salePrice: number; addonSell?: number; contract: number; addon?: number; remedial?: number; extra?: number; frozen?: boolean; capturedAt?: string; source?: string; warnings?: string[]; available?: boolean }): Pnl {
  const addonSell = r2(input.addonSell || 0);
  const revenue = r2(input.salePrice + addonSell);
  const breakdown = { contract: r2(input.contract || 0), addon: r2(input.addon || 0), remedial: r2(input.remedial || 0), extra: r2(input.extra || 0) };
  const cost = r2(breakdown.contract + breakdown.addon + breakdown.remedial + breakdown.extra);
  const profit = r2(revenue - cost);
  return { stage: input.stage, available: input.available ?? true, frozen: !!input.frozen, capturedAt: input.capturedAt, source: input.source, salePrice: r2(input.salePrice), addonSell, revenue, breakdown, cost, profit, marginPct: revenue > 0 ? r2((profit / revenue) * 100) : 0, warnings: input.warnings || [] };
}

// ------------------------------------------------------------ order costs
export type PnlOrderInput = Pick<SupplierOrder, "id" | "status"> & Partial<Pick<SupplierOrder, "reference" | "supplierName" | "orderType" | "createdAt" | "lines" | "orderedNet" | "ack">>;

export interface AckTotals {
  orderedCost: number;
  acknowledgedCost: number;
  delta: number;
  extrasTotal: number;
  unacknowledgedCost: number;
  extraInAckCost: number;
  coverage: { matched: number; missing: number; extra: number; total: number };
}
const codeKey = (c: string | undefined) => (c || "").trim().toUpperCase();

// Supplier-acknowledged cost of an order. RULE: Σ paired lines at the
// SUPPLIER's qty × unit price + Σ order lines missing from the ack AT THE
// ORDERED PRICE (we assume they will still be charged — flagged, never
// dropped, so a partial ack can never flatter the Supplier P&L) + Σ ack
// lines not on the order + Σ extras (carriage, surcharges; discounts
// negative). The printed total is never used as cost.
export function ackTotals(o: Pick<PnlOrderInput, "lines" | "orderedNet" | "ack">): AckTotals {
  const lines = o.lines || [];
  const ordered = r2(orderedCost({ lines, orderedNet: o.orderedNet } as SupplierOrder));
  const ack = o.ack;
  if (!ack || !ack.lines?.length) return { orderedCost: ordered, acknowledgedCost: ordered, delta: 0, extrasTotal: 0, unacknowledgedCost: 0, extraInAckCost: 0, coverage: { matched: 0, missing: lines.length, extra: 0, total: lines.length } };
  const pool = new Map<string, typeof ack.lines>();
  for (const a of ack.lines) { const k = codeKey(a.code); pool.set(k, [...(pool.get(k) || []), a]); }
  let matched = 0, matchedCount = 0, unacknowledged = 0, missing = 0;
  for (const l of lines) {
    const bucket = pool.get(codeKey(l.code));
    const a = bucket?.shift();
    if (a) { matched += a.qty * a.unitCost; matchedCount += 1; } else { unacknowledged += l.qty * l.unitCost; missing += 1; }
  }
  const extraLines = Array.from(pool.values()).flat();
  const extraInAckCost = r2(extraLines.reduce((s, a) => s + a.qty * a.unitCost, 0));
  const extrasTotal = r2((ack.extras || []).reduce((s, x) => s + (x.amount || 0), 0));
  const acknowledgedCost = r2(matched + unacknowledged + extraInAckCost + extrasTotal);
  return { orderedCost: ordered, acknowledgedCost, delta: r2(acknowledgedCost - ordered), extrasTotal, unacknowledgedCost: r2(unacknowledged), extraInAckCost, coverage: { matched: matchedCount, missing, extra: extraLines.length, total: lines.length } };
}
// Cost basis for the Supplier P&L: acknowledged where the supplier has confirmed prices, ordered otherwise.
export function supplierCostFor(o: Pick<PnlOrderInput, "lines" | "orderedNet" | "ack">): { cost: number; basis: "acknowledged" | "ordered" } {
  if (o.ack?.lines?.length) return { cost: ackTotals(o).acknowledgedCost, basis: "acknowledged" };
  return { cost: r2(orderedCost({ lines: o.lines || [], orderedNet: o.orderedNet } as SupplierOrder)), basis: "ordered" };
}
export const orderSell = (o: Pick<PnlOrderInput, "lines">) => r2((o.lines || []).reduce((s, l) => s + l.qty * (l.unitSell || 0), 0));

export interface OrderCostBreakdown {
  contractCost: number;
  addonCost: number;
  addonSell: number;
  remedialCost: number;
  extraCost: number;
  orderIds: string[];
  postCutoff: { orders: number; cost: number; extras: number; extraCost: number };
}
// Costs from purchase orders (+ manual extras) up to an optional cut-off.
// Cancelled orders never count. Orders without a createdAt count always.
// costBasis "supplier" uses the supplier-acknowledged cost where an ack exists.
export function liveOrderCosts(orders: PnlOrderInput[], extras: ExtraCost[] | null | undefined, opts: { asOf?: string | null; costBasis?: "ordered" | "supplier" } = {}): OrderCostBreakdown {
  const cutoff = opts.asOf ? new Date(opts.asOf).getTime() : null;
  const live = orders.filter((o) => o.status !== "cancelled");
  const inWindow = (at: string | undefined) => cutoff == null || !at || new Date(at).getTime() <= cutoff;
  const counted = live.filter((o) => inWindow(o.createdAt));
  const later = live.filter((o) => !inWindow(o.createdAt));
  const costOf = (o: PnlOrderInput) => (opts.costBasis === "supplier" ? supplierCostFor(o).cost : r2(orderedCost({ lines: o.lines || [], orderedNet: o.orderedNet } as SupplierOrder)));
  const sum = (rows: PnlOrderInput[], type: string, field: "cost" | "sell") =>
    r2(rows.filter((o) => (type === "contract" ? !o.orderType || o.orderType === "contract" : o.orderType === type)).reduce((s, o) => s + (field === "cost" ? costOf(o) : orderSell(o)), 0));
  const extrasIn = (extras || []).filter((e) => inWindow(e.date));
  const extrasOut = (extras || []).filter((e) => !inWindow(e.date));
  return {
    contractCost: sum(counted, "contract", "cost"),
    addonCost: sum(counted, "addon", "cost"),
    addonSell: sum(counted, "addon", "sell"),
    remedialCost: sum(counted, "remedial", "cost"),
    extraCost: r2(extrasIn.reduce((s, e) => s + (e.amount || 0), 0)),
    orderIds: counted.map((o) => o.id),
    postCutoff: { orders: later.length, cost: r2(later.reduce((s, o) => s + costOf(o), 0)), extras: extrasOut.length, extraCost: r2(extrasOut.reduce((s, e) => s + (e.amount || 0), 0)) },
  };
}

// --------------------------------------------------------------- the P&Ls
export type PnlProject = Pick<Project, "wonValue" | "extraCosts" | "costing" | "supplyOnly" | "deliveryDate" | "signOff2At" | "stage2Date">;
const salePriceOf = (p: Pick<Project, "wonValue">) => r2(p.wonValue || 0);
const empty = (stage: PnlStage, salePrice: number): Pnl => computePnl({ stage, salePrice, contract: 0, available: false, source: "not captured" });

function fromSnapshot(stage: "sales" | "order", s: CostStageSummary): Pnl {
  return computePnl({ stage, salePrice: s.revenue, contract: s.totalCost, frozen: true, capturedAt: s.capturedAt, source: s.note || `${stage} costing snapshot` });
}

export function salesPnl(p: PnlProject): Pnl {
  const snap = p.costing?.sales;
  return snap ? fromSnapshot("sales", snap) : empty("sales", salePriceOf(p));
}

export function orderPnl(p: PnlProject, orders: PnlOrderInput[]): Pnl {
  const snap = p.costing?.order;
  if (snap) return fromSnapshot("order", snap);
  // live from the purchase orders until a survey-order costing is frozen
  const costs = liveOrderCosts(orders, null);
  if (costs.orderIds.length === 0) return empty("order", salePriceOf(p));
  return computePnl({ stage: "order", salePrice: salePriceOf(p), addonSell: costs.addonSell, contract: costs.contractCost, addon: costs.addonCost, remedial: 0, frozen: false, source: `${costs.orderIds.length} supplier order${costs.orderIds.length === 1 ? "" : "s"} (live)` });
}

// Supplier P&L: the live Order basis (contract + add-on, no remedials/extras)
// priced at what the suppliers have acknowledged — so Order → Supplier
// isolates price drift, carriage and surcharges.
export function supplierPnl(p: PnlProject, orders: PnlOrderInput[]): Pnl {
  const live = orders.filter((o) => o.status !== "cancelled");
  const costs = liveOrderCosts(orders, null, { costBasis: "supplier" });
  if (!costs.orderIds.length) return empty("supplier", salePriceOf(p));
  const acked = live.filter((o) => supplierCostFor(o).basis === "acknowledged");
  const withSupplier = live.filter((o) => ["sent", "acknowledged", "discrepancy", "confirmed"].includes(o.status) && supplierCostFor(o).basis === "ordered");
  const warnings: string[] = [];
  if (withSupplier.length) warnings.push(`${withSupplier.length} order${withSupplier.length === 1 ? "" : "s"} with the supplier but not acknowledged — ordered prices used (${withSupplier.map((o) => o.reference || o.id).join(", ")})`);
  for (const o of acked) {
    const t = ackTotals(o);
    if (Math.abs(t.delta) >= 1) warnings.push(`${o.reference || o.id}${o.supplierName ? ` (${o.supplierName})` : ""}: supplier ${t.delta > 0 ? "+" : "−"}${gbp2(Math.abs(t.delta))} vs ordered${t.extrasTotal ? ` (incl. ${gbp2(t.extrasTotal)} extras)` : ""}${t.coverage.missing ? ` · ${t.coverage.missing} line${t.coverage.missing === 1 ? "" : "s"} unacknowledged` : ""}`);
  }
  return computePnl({ stage: "supplier", salePrice: salePriceOf(p), addonSell: costs.addonSell, contract: costs.contractCost, addon: costs.addonCost, remedial: 0, frozen: false, source: `${acked.length} of ${live.length} order${live.length === 1 ? "" : "s"} acknowledged (live)`, warnings });
}

// Completion P&L: what the suppliers actually invoiced (QuickBooks ledger by
// class) + manual extras. `ledger` is undefined when the ledger could not be
// read (QuickBooks down / not connected), null when no bill has been posted to
// the project yet. Orders whose supplier has not invoiced keep the stage
// "awaiting" — the running total is reported in `source`.
const ORDER_WITH_SUPPLIER = new Set(["sent", "acknowledged", "discrepancy", "confirmed"]);
export interface CompletionOptions { aliases?: SupplierAliasIndex }
export function completionPnl(p: PnlProject, orders: PnlOrderInput[], ledger: ProjectLedger | null | undefined, opts: CompletionOptions = {}): Pnl {
  const salePrice = salePriceOf(p);
  const costs = liveOrderCosts(orders, p.extraCosts);
  const pending = (source: string, warnings: string[] = []): Pnl =>
    computePnl({ stage: "completion", salePrice, addonSell: costs.addonSell, contract: ledger?.net || 0, extra: costs.extraCost, available: false, source, warnings });
  if (ledger === undefined) return pending("QuickBooks ledger unavailable — supplier invoices cannot be read");
  if (ledger === null) return pending("Awaiting supplier invoices — nothing posted to this project's QuickBooks class yet");
  if (ledger.ambiguous?.length) return pending(`QuickBooks class ambiguous: ${ledger.ambiguous.join(" / ")} — pick one in QuickBooks`);

  // Coverage: every supplier we have an order with must have invoiced. With no
  // purchase orders there is nothing to check the bills against, so the stage
  // stays pending and shows what the ledger holds.
  const live = orders.filter((o) => o.status !== "cancelled" && ORDER_WITH_SUPPLIER.has(o.status) && o.supplierName);
  const suppliers = Array.from(new Set(live.map((o) => o.supplierName as string)));
  if (!suppliers.length) return pending(`${gbp2(ledger.net)} invoiced in QuickBooks (${ledger.docs} document${ledger.docs === 1 ? "" : "s"}) — no CRM supplier orders to check it against`);
  const missing = suppliers.filter((s) => !ledger.vendors.some((v) => vendorMatches(s, v.vendor, opts.aliases)));
  const invoicedFrom = suppliers.length - missing.length;
  if (missing.length) return pending(`Awaiting invoices from ${missing.join(", ")} · ${gbp2(ledger.net)} received from ${invoicedFrom} of ${suppliers.length} suppliers`);

  const warnings: string[] = [];
  const acked = liveOrderCosts(orders, null, { costBasis: "supplier" });
  const expected = r2(acked.contractCost + acked.addonCost + acked.remedialCost);
  if (expected > 0 && Math.abs(ledger.net - expected) >= Math.max(1, expected * 0.01)) warnings.push(`Invoiced ${gbp2(ledger.net)} vs ${gbp2(expected)} ordered/acknowledged (${ledger.net > expected ? "+" : "−"}${gbp2(Math.abs(ledger.net - expected))})`);
  for (const v of ledger.vendors) if (!suppliers.some((s) => vendorMatches(s, v.vendor, opts.aliases))) warnings.push(`${v.vendor}: ${gbp2(v.net)} invoiced with no CRM order`);
  return computePnl({ stage: "completion", salePrice, addonSell: costs.addonSell, contract: ledger.net, addon: 0, remedial: 0, extra: costs.extraCost, frozen: false, source: `${ledger.docs} supplier invoice${ledger.docs === 1 ? "" : "s"} in QuickBooks (${ledger.className})${ledger.lastTxnDate ? ` · last ${ledger.lastTxnDate}` : ""}${costs.extraCost ? ` + ${gbp2(costs.extraCost)} extras` : ""}`, warnings });
}

// Ledger-vs-ledger: Σ acknowledged vs Σ ordered over the live orders — the
// exact "what the suppliers will charge vs what we ordered" number.
export interface SupplierDrift { ordered: number; acknowledged: number; delta: number; extras: number; acknowledgedOrders: number; totalOrders: number }
export function supplierDrift(orders: PnlOrderInput[]): SupplierDrift | null {
  const live = orders.filter((o) => o.status !== "cancelled");
  if (!live.length) return null;
  let ordered = 0, acknowledged = 0, extras = 0, acked = 0;
  for (const o of live) {
    const t = ackTotals(o);
    ordered += t.orderedCost;
    acknowledged += supplierCostFor(o).cost;
    extras += t.extrasTotal;
    if (o.ack?.lines?.length) acked += 1;
  }
  if (!acked) return null;
  return { ordered: r2(ordered), acknowledged: r2(acknowledged), delta: r2(acknowledged - ordered), extras: r2(extras), acknowledgedOrders: acked, totalOrders: live.length };
}

export interface PnlComparison {
  sales: Pnl;
  order: Pnl;
  supplier: Pnl;
  completion: Pnl;
  supplierDrift: SupplierDrift | null;
  deltas: {
    salesToOrder: { profit: number; marginPts: number; cost: number } | null;
    orderToSupplier: { profit: number; marginPts: number; cost: number } | null;
    orderToCompletion: { profit: number; marginPts: number; cost: number } | null;
  };
  extraSpend: { remedial: number; extra: number; addonCost: number; addonSell: number; total: number };
  postCompletion: { orders: number; cost: number; extras: number; extraCost: number } | null;
}

// `ledger` — the project's QuickBooks supplier-invoice totals: undefined =
// ledger unreadable, null = nothing posted yet.
export function pnlComparison(p: PnlProject, orders: PnlOrderInput[], ledger?: ProjectLedger | null, opts: CompletionOptions = {}): PnlComparison {
  const sales = salesPnl(p);
  const order = orderPnl(p, orders);
  const supplier = supplierPnl(p, orders);
  const completion = completionPnl(p, orders, ledger, opts);
  const delta = (a: Pnl, b: Pnl) => (a.available && b.available ? { profit: r2(b.profit - a.profit), marginPts: r2(b.marginPct - a.marginPct), cost: r2(b.cost - a.cost) } : null);
  const cutoff = completionCutoff(p);
  const post = cutoff ? liveOrderCosts(orders, p.extraCosts, { asOf: cutoff }).postCutoff : null;
  // Remedials and extras are CRM facts and are reported whether or not the suppliers have invoiced them yet.
  const spend = liveOrderCosts(orders, p.extraCosts);
  return {
    sales, order, supplier, completion,
    supplierDrift: supplierDrift(orders),
    deltas: { salesToOrder: delta(sales, order), orderToSupplier: delta(order, supplier), orderToCompletion: delta(order, completion) },
    extraSpend: { remedial: spend.remedialCost, extra: spend.extraCost, addonCost: spend.addonCost, addonSell: spend.addonSell, total: r2(spend.remedialCost + spend.extraCost) },
    postCompletion: post && post.orders + post.extras > 0 ? post : null,
  };
}

// Loader: one project's comparison with the QuickBooks ledger and the
// supplier-playbook aliases pulled in (both optional — the P&L degrades).
export async function projectPnl(project: Project): Promise<PnlComparison & { supplierInvoices: ProjectLedger | null }> {
  const [ledger, aliases] = await Promise.all([ledgerCostsByClass().catch(() => undefined), listSupplierProfiles().then(supplierAliasIndex).catch(() => undefined)]);
  const pl = projectLedgerCosts(project, ledger);
  return { ...pnlComparison(project, project.supplierOrders || [], pl, { aliases }), supplierInvoices: pl ?? null };
}
