// Turn a CRM payload into our Project shape. A mapping is { ourField: "json.path" }
// (see docs/CRM-CONNECTOR.md); common field names are recognised without one
// (id, firstName/lastName or name/customer, email, postcode, value/wonValue,
// wonDate, status/stage, designer/owner, dates, orders/supplierOrders).
import { r2 } from "@/lib/core/domain";
import { getPath } from "./connectors";
import type { Project, SupplierOrder } from "./types";

export type IncomingProject = Omit<Partial<Project>, "id" | "source" | "createdAt" | "updatedAt"> & { id?: string; firstName: string; lastName: string };

const str = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
const num = (v: unknown): number | null => { if (v === undefined || v === null || v === "") return null; const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? r2(n) : null; };
const date = (v: unknown): string | null => { const s = str(v); if (!s || s === "N/A") return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
const first = (raw: unknown, paths: string[]): unknown => { for (const p of paths) { const v = getPath(raw, p); if (v !== undefined && v !== null && v !== "") return v; } return undefined; };

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: "", lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}
function status(v: unknown): Project["status"] {
  const s = String(v || "").toLowerCase();
  if (/cancel/.test(s)) return "cancelled";
  if (/lost|dead|closed lost/.test(s)) return "lost";
  if (/complete|done|signed off|finished|delivered/.test(s)) return "completed";
  return "active";
}
function orders(v: unknown): SupplierOrder[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((o: any, i: number) => ({
    id: str(o.id) || `${str(o.reference) || "PO"}-${i}`,
    reference: str(o.reference ?? o.poNumber ?? o.po ?? o.number) || `PO-${i + 1}`,
    supplierName: str(o.supplierName ?? o.supplier?.name ?? o.supplier ?? o.vendor) || "Unknown supplier",
    supplierId: str(o.supplierId ?? o.supplier?.id) ?? null,
    status: (["draft", "pending_signoff", "signed_off", "sent", "acknowledged", "discrepancy", "confirmed", "cancelled"].includes(String(o.status)) ? o.status : o.ack ? "acknowledged" : "sent") as SupplierOrder["status"],
    orderType: (["contract", "addon", "remedial"].includes(String(o.orderType ?? o.type)) ? (o.orderType ?? o.type) : "contract") as SupplierOrder["orderType"],
    lines: Array.isArray(o.lines) ? o.lines.map((l: any) => ({ code: str(l.code ?? l.sku) || "", description: str(l.description ?? l.name) || "", qty: num(l.qty ?? l.quantity) ?? 1, unitCost: num(l.unitCost ?? l.cost ?? l.price) ?? 0, unitSell: num(l.unitSell ?? l.sell) ?? undefined, catalog: str(l.catalog ?? l.catalogue) ?? undefined })) : [],
    orderedNet: num(o.orderedNet ?? o.net ?? o.total ?? o.value),
    ack: o.ack ?? null,
    sentAt: date(o.sentAt) ?? null,
    createdAt: str(o.createdAt) || new Date().toISOString(),
    notes: str(o.notes) ?? null,
  }));
}

export function normaliseIncomingProject(raw: unknown, mapping: Record<string, string> = {}): IncomingProject {
  const m = (field: string, fallbacks: string[]) => (mapping[field] ? getPath(raw, mapping[field]) : first(raw, fallbacks));
  const fullName = str(m("name", ["name", "customer", "customerName", "client", "clientName", "title"]));
  let firstName = str(m("firstName", ["firstName", "first_name", "contact.firstName"])) || "";
  let lastName = str(m("lastName", ["lastName", "last_name", "surname", "contact.lastName"])) || "";
  if (!firstName && !lastName && fullName) ({ firstName, lastName } = splitName(fullName));
  const salesCost = num(m("salesCost", ["costing.sales.totalCost", "salesCost"]));
  const salesRevenue = num(m("salesRevenue", ["costing.sales.revenue", "salesRevenue"]));
  const orderCost = num(m("orderCost", ["costing.order.totalCost", "orderCost"]));
  const orderRevenue = num(m("orderRevenue", ["costing.order.revenue", "orderRevenue"]));
  const wonValue = num(m("wonValue", ["wonValue", "value", "netValue", "orderValue", "amount", "dealValue"]));
  const mk = (revenue: number | null, cost: number | null) => (revenue != null && cost != null ? { revenue, totalCost: cost, profit: r2(revenue - cost), marginPct: revenue > 0 ? r2(((revenue - cost) / revenue) * 100) : 0, capturedAt: new Date().toISOString() } : null);
  return {
    id: str(m("id", ["id", "_id", "projectId", "leadId", "dealId", "reference"])) || undefined,
    firstName, lastName,
    email: str(m("email", ["email", "contact.email", "customerEmail"])),
    phone: str(m("phone", ["phone", "contact.phone", "mobile"])),
    postcode: str(m("postcode", ["postcode", "postCode", "zip", "address.postcode", "address.zip"])),
    address: str(m("address", ["address", "address.line1", "siteAddress"])),
    designer: str(m("designer", ["designer", "owner", "assignedTo", "salesperson", "accountOwner", "owner.email"])),
    status: status(m("status", ["financeStatus", "status", "stage", "opsStage", "pipelineStage"])),
    opsStage: str(m("opsStage", ["opsStage", "stage", "pipelineStage", "status"])),
    wonDate: date(m("wonDate", ["wonDate", "closedAt", "closeDate", "orderDate", "signedAt"])),
    wonValue,
    orderFinance: (m("orderFinance", ["orderFinance"]) as Project["orderFinance"]) ?? undefined,
    payments: (m("payments", ["payments", "receipts"]) as Project["payments"]) ?? undefined,
    invoices: (m("invoices", ["invoices"]) as Project["invoices"]) ?? undefined,
    supplierOrders: orders(m("supplierOrders", ["supplierOrders", "orders", "purchaseOrders"])) ?? undefined,
    costing: salesRevenue != null || orderRevenue != null ? { sales: mk(salesRevenue ?? wonValue, salesCost), order: mk(orderRevenue ?? wonValue, orderCost) } : undefined,
    surveyOrderAt: date(m("surveyOrderAt", ["surveyOrderAt", "surveySignedAt"])),
    deliveryDate: date(m("deliveryDate", ["deliveryDate", "delivery"])),
    installStart: date(m("installStart", ["installStart", "installationStart", "installDate"])),
    installEnd: date(m("installEnd", ["installEnd", "installationEnd"])),
    signOff1At: date(m("signOff1At", ["signOff1At", "stage1SignOff", "practicalCompletionAt"])),
    signOff2At: date(m("signOff2At", ["signOff2At", "stage2SignOff", "finalSignOffAt", "completedAt"])),
    supplyOnly: (m("supplyOnly", ["supplyOnly"]) as boolean | undefined) ?? undefined,
    qbo: (m("qbo", ["qbo", "quickbooks"]) as Project["qbo"]) ?? undefined,
    notes: str(m("notes", ["notes", "description"])),
  };
}
