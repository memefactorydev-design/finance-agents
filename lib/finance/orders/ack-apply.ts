// The one path that writes a supplier acknowledgement onto a purchase order
// (the mailbox intake, a manual match from the review queue and an agent's
// match_order_ack all use it): pair the acknowledged lines with the ordered
// lines, list every difference, work out the acknowledged supplier cost, then
// persist the ack in the project's finance overlay, note it on the project and
// post one line to the briefs channel when there are differences.
import { r2 } from "@/lib/core/domain";
import { addProjectNote, setSupplierOrderAck, type OrderRef } from "@/lib/crm/projects";
import { orderedCost, type AckDiscrepancy, type AckExtra, type AckLine, type OrderAck, type OrderLine, type SupplierOrder } from "@/lib/crm/types";
import { postBrief } from "@/lib/finance/briefs";

// "4", "4.1", or "" when the line carries no plan position
export function positionLabel(l: Pick<OrderLine, "position" | "subPosition"> | null | undefined): string {
  if (!l || l.position == null || !Number.isFinite(l.position)) return "";
  return l.subPosition ? `${l.position}.${l.subPosition}` : String(l.position);
}

// ------------------------------------------------------------------ pairing
export interface AckPair { order: OrderLine; ack: AckLine }
export interface AckGroup { code: string; order: OrderLine[]; ack: AckLine[] }
export interface AckPairing {
  pairs: AckPair[];      // matched one-to-one on plan position
  groups: AckGroup[];    // matched by article code, compared as aggregates
  missing: OrderLine[];  // ordered, not on the acknowledgement
  extra: AckLine[];      // on the acknowledgement, not ordered
}

const norm = (s: string | null | undefined) => (s || "").trim().toLowerCase();
const normPos = (s: string | null | undefined) => norm(s).replace(/^(pos|position|item|line)\.?\s*/i, "").replace(/^#/, "");
const normDesc = (s: string | null | undefined) => norm(s).replace(/\s+/g, " ");

// Pair order lines with acknowledgement lines: (1) same plan position (and
// same code, or no code on the ack); (2) remaining lines grouped by code on
// both sides — a supplier may consolidate 7 × "99PUSH" into one line of 7,
// and we may hold 4 identical units as 4 lines; (3) code-less lines (free
// positions such as worktops) by identical description.
export function pairOrderAndAck(orderLines: OrderLine[], ackLines: AckLine[]): AckPairing {
  const usedAck = new Set<number>();
  const usedOrder = new Set<number>();
  const pairs: AckPair[] = [];
  const groups: AckGroup[] = [];
  const missing: OrderLine[] = [];
  const extra: AckLine[] = [];

  const ackByPos = new Map<string, number[]>();
  ackLines.forEach((a, i) => {
    const p = normPos(a.position);
    if (p) ackByPos.set(p, [...(ackByPos.get(p) || []), i]);
  });
  orderLines.forEach((o, oi) => {
    const label = positionLabel(o).toLowerCase();
    if (!label) return;
    const hit = (ackByPos.get(label) || []).find((i) => !usedAck.has(i) && (!norm(ackLines[i].code) || norm(ackLines[i].code) === norm(o.code)));
    if (hit == null) return;
    usedAck.add(hit);
    usedOrder.add(oi);
    pairs.push({ order: o, ack: ackLines[hit] });
  });

  const orderByCode = new Map<string, OrderLine[]>();
  const orderNoCode: OrderLine[] = [];
  orderLines.forEach((o, oi) => {
    if (usedOrder.has(oi)) return;
    const c = norm(o.code);
    if (!c) orderNoCode.push(o);
    else orderByCode.set(c, [...(orderByCode.get(c) || []), o]);
  });
  const ackByCode = new Map<string, AckLine[]>();
  const ackNoCode: AckLine[] = [];
  ackLines.forEach((a, i) => {
    if (usedAck.has(i)) return;
    const c = norm(a.code);
    if (!c) ackNoCode.push(a);
    else ackByCode.set(c, [...(ackByCode.get(c) || []), a]);
  });
  for (const [code, os] of Array.from(orderByCode.entries())) {
    const as = ackByCode.get(code);
    if (!as) { missing.push(...os); continue; }
    groups.push({ code: os[0].code, order: os, ack: as });
    ackByCode.delete(code);
  }
  for (const as of Array.from(ackByCode.values())) extra.push(...as);

  // Code-less lines: identical description only
  const takenAck = new Set<number>();
  for (const o of orderNoCode) {
    const idx = ackNoCode.findIndex((a, i) => !takenAck.has(i) && normDesc(a.description) && normDesc(a.description) === normDesc(o.description));
    if (idx === -1) { missing.push(o); continue; }
    takenAck.add(idx);
    pairs.push({ order: o, ack: ackNoCode[idx] });
  }
  ackNoCode.forEach((a, i) => { if (!takenAck.has(i)) extra.push(a); });

  return { pairs, groups, missing, extra };
}

const weighted = (rows: { qty: number; unitCost: number }[]) => {
  const q = rows.reduce((s, l) => s + l.qty, 0);
  return { qty: r2(q), unitCost: q > 0 ? r2(rows.reduce((s, l) => s + l.qty * l.unitCost, 0) / q) : 0 };
};

// --------------------------------------------------------------- comparison
// Order-vs-acknowledgement comparison: qty and unit-cost deltas over 1p,
// missing and extra lines, extra charges (carriage etc.) and a printed-total
// sanity check. Any difference → "discrepancy" (the owner reviews before
// confirming; extras are exactly the margin leak they want to see).
export function compareOrderToAck(
  orderLines: OrderLine[],
  ackLines: AckLine[],
  opts: { extras?: AckExtra[] | null; total?: number | null } = {},
): { discrepancies: AckDiscrepancy[]; status: "match" | "discrepancy" } {
  const d: AckDiscrepancy[] = [];
  const { pairs, groups, missing, extra } = pairOrderAndAck(orderLines, ackLines);
  const check = (code: string, position: string | undefined, o: { qty: number; unitCost: number }, a: { qty: number; unitCost: number }) => {
    if (Math.abs(a.qty - o.qty) > 0.001) {
      d.push({ lineCode: code, field: "qty", ordered: String(o.qty), acknowledged: String(a.qty), position, delta: r2((a.qty - o.qty) * o.unitCost) });
    }
    if (Math.abs(a.unitCost - o.unitCost) > 0.01) {
      d.push({ lineCode: code, field: "unitCost", ordered: o.unitCost.toFixed(2), acknowledged: a.unitCost.toFixed(2), position, delta: r2((a.unitCost - o.unitCost) * a.qty) });
    }
  };
  for (const p of pairs) check(p.order.code || p.order.description, positionLabel(p.order) || p.ack.position, p.order, p.ack);
  for (const g of groups) {
    const positions = g.order.map(positionLabel).filter(Boolean).join(", ") || undefined;
    check(g.code, positions, weighted(g.order), weighted(g.ack));
  }
  for (const line of missing) {
    d.push({ lineCode: line.code || line.description, field: "missing_from_ack", ordered: `${line.qty} × ${line.description}`, acknowledged: "—", position: positionLabel(line) || undefined, delta: 0 });
  }
  for (const a of extra) {
    d.push({ lineCode: a.code || a.description || "?", field: "extra_in_ack", ordered: "—", acknowledged: `${a.qty} × ${a.description || a.code}`, position: a.position, delta: r2(a.qty * a.unitCost) });
  }
  for (const x of opts.extras || []) {
    if (Math.abs(x.amount) >= 0.01) d.push({ lineCode: x.label, field: "extra_charge", ordered: "—", acknowledged: x.amount.toFixed(2), delta: r2(x.amount) });
  }
  if (opts.total != null && Number.isFinite(opts.total)) {
    const computed = r2(ackLines.reduce((s, l) => s + l.qty * l.unitCost, 0) + (opts.extras || []).reduce((s, x) => s + x.amount, 0));
    if (Math.abs(opts.total - computed) > Math.max(1, computed * 0.005)) {
      d.push({ lineCode: "TOTAL", field: "total", ordered: computed.toFixed(2), acknowledged: opts.total.toFixed(2) });
    }
  }
  return { discrepancies: d, status: d.length ? "discrepancy" : "match" };
}

// ------------------------------------------------------------------- totals
export interface AckTotals {
  orderedCost: number;
  acknowledgedCost: number;
  delta: number;
  extrasTotal: number;
  unacknowledgedCost: number;
  extraInAckCost: number;
  coverage: { matched: number; missing: number; extra: number; total: number };
}

// Supplier-acknowledged cost of an order. RULE: Σ paired lines at the
// SUPPLIER's qty × unit price + Σ order lines missing from the ack AT THE
// ORDERED PRICE (we assume they will still be charged — flagged, never
// dropped, so a partial ack can never flatter the supplier P&L) + Σ ack
// lines not on the order + Σ extras (carriage, surcharges; discounts
// negative). The printed total is never used as cost.
export function ackTotals(o: Pick<SupplierOrder, "lines" | "orderedNet" | "ack">): AckTotals {
  const lines = o.lines || [];
  const ordered = r2(orderedCost({ ...o, lines } as SupplierOrder));
  const ack = o.ack;
  if (!ack || !ack.lines?.length) {
    return { orderedCost: ordered, acknowledgedCost: ordered, delta: 0, extrasTotal: 0, unacknowledgedCost: 0, extraInAckCost: 0, coverage: { matched: 0, missing: lines.length, extra: 0, total: lines.length } };
  }
  const { pairs, groups, missing, extra } = pairOrderAndAck(lines, ack.lines);
  const matched = pairs.reduce((s, p) => s + p.ack.qty * p.ack.unitCost, 0)
    + groups.reduce((s, g) => s + g.ack.reduce((t, a) => t + a.qty * a.unitCost, 0), 0);
  const unacknowledgedCost = r2(missing.reduce((s, l) => s + l.qty * l.unitCost, 0));
  const extraInAckCost = r2(extra.reduce((s, a) => s + a.qty * a.unitCost, 0));
  const extrasTotal = r2((ack.extras || []).reduce((s, x) => s + (x.amount || 0), 0));
  const acknowledgedCost = r2(matched + unacknowledgedCost + extraInAckCost + extrasTotal);
  return {
    orderedCost: ordered, acknowledgedCost, delta: r2(acknowledgedCost - ordered), extrasTotal, unacknowledgedCost, extraInAckCost,
    coverage: { matched: pairs.length + groups.reduce((s, g) => s + g.order.length, 0), missing: missing.length, extra: extra.length, total: lines.length },
  };
}

// Cost basis for the supplier P&L: acknowledged where the supplier has
// confirmed prices, ordered prices otherwise.
export function supplierCostFor(o: Pick<SupplierOrder, "lines" | "orderedNet" | "ack">): { cost: number; basis: "acknowledged" | "ordered" } {
  if (o.ack?.lines?.length) return { cost: ackTotals(o).acknowledgedCost, basis: "acknowledged" };
  return { cost: r2(orderedCost(o as SupplierOrder)), basis: "ordered" };
}

// --------------------------------------------------------------- the writer
export interface AckInput {
  lines: AckLine[];
  extras?: AckExtra[];
  supplierRef?: string | null;
  expectedDate?: string | null;
  subtotal?: number | null;
  vat?: number | null;
  total?: number | null;
  currency?: string | null;
}
export interface AckMeta {
  filename?: string;
  receivedAt?: string;
  extractedBy: NonNullable<OrderAck["extractedBy"]>;
  source: NonNullable<OrderAck["source"]>;
  mailbox?: string;
  messageId?: string;
}

// One pure builder for every ack writer: the OrderAck to store plus what it means.
export function buildAck(
  order: Pick<SupplierOrder, "lines" | "orderedNet">,
  x: AckInput,
  meta: AckMeta & { by?: string; how?: string },
): { ack: OrderAck; totals: AckTotals; status: "match" | "discrepancy"; discrepancies: AckDiscrepancy[] } {
  const extras = (x.extras || []).filter((e) => e && Number.isFinite(e.amount) && Math.abs(e.amount) >= 0.01);
  const { discrepancies, status } = compareOrderToAck(order.lines, x.lines, { extras, total: x.total ?? null });
  const ack: OrderAck = {
    filename: meta.filename,
    receivedAt: meta.receivedAt || new Date().toISOString(),
    lines: x.lines,
    discrepancies,
    status,
    extractedBy: meta.extractedBy,
    supplierRef: x.supplierRef || null,
    expectedDate: x.expectedDate || null,
    extras,
    subtotal: x.subtotal ?? null,
    vat: x.vat ?? null,
    total: x.total ?? null,
    currency: x.currency || "GBP",
    source: meta.source,
    mailbox: meta.mailbox,
    messageId: meta.messageId,
    appliedBy: meta.by,
    how: meta.how,
  };
  const totals = ackTotals({ lines: order.lines, orderedNet: order.orderedNet, ack });
  return { ack, totals, status, discrepancies };
}

const gbp2 = (v: number) => `£${Math.abs(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function discrepancySummary(d: AckDiscrepancy[]): string {
  if (!d.length) return "all lines match";
  const label = (x: AckDiscrepancy) => {
    const pos = x.position ? `Pos ${x.position} ` : "";
    switch (x.field) {
      case "missing_from_ack": return `${pos}${x.lineCode} not acknowledged`;
      case "extra_in_ack": return `${pos}${x.lineCode} extra in ack`;
      case "extra_charge": return `${x.lineCode} £${x.acknowledged}`;
      case "total": return `total ${x.ordered} vs ${x.acknowledged}`;
      case "qty": return `${pos}${x.lineCode} qty ${x.ordered} → ${x.acknowledged}`;
      default: return `${pos}${x.lineCode} price ${x.ordered} → ${x.acknowledged}`;
    }
  };
  return `${d.length} ${d.length === 1 ? "difference" : "differences"}: ${d.slice(0, 4).map(label).join("; ")}${d.length > 4 ? "; …" : ""}`;
}

export async function applyAck(
  order: OrderRef,
  input: AckInput,
  meta: AckMeta & { by: string; how: string },
): Promise<{ updated: SupplierOrder | null; ack: OrderAck; status: "match" | "discrepancy"; discrepancies: AckDiscrepancy[]; totals: AckTotals }> {
  const { ack, totals, status, discrepancies } = buildAck(order, input, meta);
  // The finance overlay owns the ack: a CRM re-sync never loses it, and the
  // merged order becomes acknowledged / discrepancy from it.
  const project = await setSupplierOrderAck(order.projectId, order.id, ack);
  const updated = (project.supplierOrders || []).find((o) => o.id === order.id) ?? null;
  const deltaText = `${totals.delta >= 0 ? "+" : "−"}${gbp2(Math.abs(totals.delta))}`;
  const costText = `supplier cost ${gbp2(totals.acknowledgedCost)} vs ordered ${gbp2(totals.orderedCost)} (${deltaText})`;
  const theirRef = ack.supplierRef ? ` (their ref ${ack.supplierRef})` : "";
  const expected = ack.expectedDate ? ` · expected ${ack.expectedDate}` : "";

  await addProjectNote(
    order.projectId,
    `Supplier acknowledgement ${status === "match" ? "matches" : "has differences"} — ${order.reference}: ${order.supplierName}${theirRef} · ${input.lines.length} ${input.lines.length === 1 ? "line" : "lines"} · ${discrepancySummary(discrepancies)} · ${costText}${expected} · ${meta.how}${meta.mailbox ? ` · from ${meta.mailbox}` : ""}${meta.filename ? ` (${meta.filename})` : ""}`,
    meta.by,
  ).catch(() => {});

  if (status === "discrepancy") {
    await postBrief({
      author: meta.by, authorKind: "agent",
      text: `Supplier acknowledgement from ${order.supplierName} for ${order.reference} (${order.projectName})${theirRef}: ${discrepancySummary(discrepancies)} · ${costText}${expected} — review the supplier cost on the order before confirming.`,
      meta: { kind: "order_ack", projectId: order.projectId, orderId: order.id, reference: order.reference, status, discrepancies: discrepancies.length, acknowledgedCost: totals.acknowledgedCost, orderedCost: totals.orderedCost },
    }).catch(() => {});
  }

  return { updated, ack, status, discrepancies: discrepancies.slice(0, 80), totals };
}
