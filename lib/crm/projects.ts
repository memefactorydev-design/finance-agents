// Projects in the finance store (PROJECT#<id>) plus the finance overlay
// (PROJECT_FINANCE#<id>) that holds what this app records itself — receipts,
// invoices, extra costs, order-finance overrides, QuickBooks mapping and
// supplier acknowledgements — so a CRM re-sync never loses them. Reads always
// return the merged view.
import { all, upsert } from "@/lib/core/store";
import { FinanceError, invariant, r2 } from "@/lib/core/domain";
import { company, financeStore } from "@/lib/core/server";
import { normName } from "@/lib/core/text";
import type { Invoice, OrderAck, Payment, Project, ProjectFinanceOverlay, SupplierOrder } from "./types";

const pkey = (id: string) => `PROJECT#${id}`;
const fkey = (id: string) => `PROJECT_FINANCE#${id}`;
export const newId = (prefix = "P") => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

function merge(p: Project, f: ProjectFinanceOverlay | null): Project {
  if (!f) return p;
  const orders = (p.supplierOrders || []).map((o) => (f.supplierOrderAcks?.[o.id] ? { ...o, ack: f.supplierOrderAcks[o.id], status: (o.status === "confirmed" || o.status === "cancelled" ? o.status : f.supplierOrderAcks[o.id].status === "match" ? "acknowledged" : "discrepancy") as SupplierOrder["status"] } : o));
  return {
    ...p,
    payments: f.payments ?? p.payments ?? [],
    invoices: f.invoices ?? p.invoices ?? [],
    extraCosts: f.extraCosts ?? p.extraCosts ?? [],
    orderFinance: f.orderFinance === undefined ? p.orderFinance ?? null : f.orderFinance,
    qbo: f.qbo ?? p.qbo ?? null,
    supplierOrders: orders,
  };
}

export async function listProjects(opts: { status?: Project["status"] | "all"; includeCancelled?: boolean } = {}): Promise<Project[]> {
  const [rows, overlays] = await Promise.all([all<Project>(financeStore(), company(), "PROJECT#"), all<ProjectFinanceOverlay>(financeStore(), company(), "PROJECT_FINANCE#")]);
  const byId = new Map(overlays.map((r) => [r.key.slice("PROJECT_FINANCE#".length), r.data]));
  const status = opts.status || "all";
  return rows.map((r) => merge(r.data, byId.get(r.data.id) ?? null))
    .filter((p) => (status === "all" ? opts.includeCancelled || p.status !== "cancelled" : p.status === status))
    .sort((a, b) => (b.wonDate || "").localeCompare(a.wonDate || "") || a.lastName.localeCompare(b.lastName));
}
export async function getProject(id: string): Promise<Project | null> {
  const [row, overlay] = await Promise.all([financeStore().get<Project>(company(), pkey(id)), financeStore().get<ProjectFinanceOverlay>(company(), fkey(id))]);
  return row ? merge(row.data, overlay?.data ?? null) : null;
}
export async function requireProject(id: string): Promise<Project> {
  const p = await getProject(id);
  if (!p) throw new FinanceError("PROJECT_NOT_FOUND", false, 404);
  return p;
}
export async function searchProjects(q: string, limit = 20): Promise<Project[]> {
  const n = normName(q);
  if (!n) return [];
  const all_ = await listProjects({ includeCancelled: true });
  return all_.filter((p) => normName(`${p.firstName} ${p.lastName}`).includes(n) || (p.postcode || "").toLowerCase().replace(/\s+/g, "").includes(n.replace(/\s+/g, "")) || (p.email || "").toLowerCase().includes(q.toLowerCase()) || p.id.toLowerCase() === q.toLowerCase()).slice(0, limit);
}

// Upsert from any source. The CRM record wins for CRM-owned fields; finance
// overlay fields are untouched. Returns the merged project.
export type ProjectInput = Omit<Partial<Project>, "id" | "source" | "createdAt" | "updatedAt"> & { id?: string; firstName: string; lastName: string; source?: Project["source"] };
export async function upsertProject(input: ProjectInput, by: string): Promise<Project> {
  invariant(input.firstName || input.lastName, "PROJECT_NAME_REQUIRED");
  const id = input.id || newId();
  const now = new Date().toISOString();
  const saved = await upsert<Project>(financeStore(), company(), pkey(id), (cur) => ({
    ...(cur || { createdAt: now }),
    ...stripUndefined(input),
    id,
    firstName: input.firstName, lastName: input.lastName,
    status: input.status || cur?.status || "active",
    wonDate: input.wonDate ?? cur?.wonDate ?? null,
    wonValue: input.wonValue ?? cur?.wonValue ?? null,
    source: input.source || cur?.source || { kind: "manual", externalId: null, syncedAt: null },
    createdAt: cur?.createdAt || now,
    updatedAt: now,
  }) as Project);
  void by;
  return (await getProject(saved.id))!;
}
export async function deleteProject(id: string): Promise<void> {
  const store = financeStore();
  for (const k of [pkey(id), fkey(id)]) {
    const row = await store.get(company(), k);
    if (row) await store.transact(company(), [{ key: k, expected: row.version, data: { ...(row.data as object), deleted: true, status: "cancelled" } }]);
  }
}

// --------------------------------------------------------------- overlay
async function patchOverlay(id: string, patch: (f: ProjectFinanceOverlay) => ProjectFinanceOverlay): Promise<Project> {
  await requireProject(id);
  await upsert<ProjectFinanceOverlay>(financeStore(), company(), fkey(id), (cur) => ({ ...patch(cur || { updatedAt: new Date().toISOString() }), updatedAt: new Date().toISOString() }));
  return (await getProject(id))!;
}
export async function setProjectPayments(id: string, payments: Payment[]): Promise<Project> { return patchOverlay(id, (f) => ({ ...f, payments: payments.map((p) => ({ ...p, amount: r2(p.amount) })) })); }
export async function setProjectInvoices(id: string, invoices: Invoice[]): Promise<Project> { return patchOverlay(id, (f) => ({ ...f, invoices })); }
export async function setProjectExtraCosts(id: string, extraCosts: Project["extraCosts"]): Promise<Project> { return patchOverlay(id, (f) => ({ ...f, extraCosts: extraCosts || [] })); }
export async function setProjectOrderFinance(id: string, orderFinance: Project["orderFinance"]): Promise<Project> { return patchOverlay(id, (f) => ({ ...f, orderFinance })); }
export async function setProjectQbo(id: string, qbo: Project["qbo"]): Promise<Project> { return patchOverlay(id, (f) => ({ ...f, qbo })); }
export async function setSupplierOrderAck(id: string, orderId: string, ack: OrderAck | null): Promise<Project> {
  return patchOverlay(id, (f) => { const acks = { ...(f.supplierOrderAcks || {}) }; if (ack) acks[orderId] = ack; else delete acks[orderId]; return { ...f, supplierOrderAcks: acks }; });
}
// Supplier orders are CRM-owned when the project is synced; manual projects edit them here.
export async function setSupplierOrders(id: string, orders: SupplierOrder[], by: string): Promise<Project> {
  const p = await requireProject(id);
  return upsertProject({ ...p, supplierOrders: orders }, by);
}

// Every supplier order across projects (the PO pool the ack matcher searches).
export interface OrderRef extends SupplierOrder { projectId: string; projectName: string; clientSurname: string; clientPostcode: string | null }
export async function listSupplierOrders(filter: { supplierId?: string | null; supplierName?: string | null; projectId?: string } = {}): Promise<OrderRef[]> {
  const projects = filter.projectId ? [await requireProject(filter.projectId)] : await listProjects({ includeCancelled: true });
  const want = filter.supplierName ? normName(filter.supplierName) : null;
  const out: OrderRef[] = [];
  for (const p of projects) for (const o of p.supplierOrders || []) {
    if (filter.supplierId && o.supplierId !== filter.supplierId) continue;
    if (want && normName(o.supplierName) !== want) continue;
    out.push({ ...o, projectId: p.id, projectName: `${p.firstName} ${p.lastName}`.trim(), clientSurname: p.lastName, clientPostcode: p.postcode || null });
  }
  return out;
}

// Notes (PROJECT_NOTE#<id>#<ts>) — also forwarded to the CRM when the connector can.
export interface ProjectNote { id: string; projectId: string; text: string; by: string; at: string }
export async function addProjectNote(projectId: string, text: string, by: string): Promise<ProjectNote> {
  await requireProject(projectId);
  const at = new Date().toISOString();
  const note: ProjectNote = { id: `${projectId}#${at}`, projectId, text: text.slice(0, 5000), by, at };
  await financeStore().transact(company(), [{ key: `PROJECT_NOTE#${projectId}#${at}`, expected: null, data: note }]);
  const { connectorWriteback } = await import("./connectors");
  connectorWriteback("note", { projectId, text, by }).catch(() => {});
  return note;
}
export async function listProjectNotes(projectId: string): Promise<ProjectNote[]> {
  return (await all<ProjectNote>(financeStore(), company(), `PROJECT_NOTE#${projectId}#`)).map((r) => r.data).sort((a, b) => b.at.localeCompare(a.at));
}
function stripUndefined<T extends object>(o: T): Partial<T> { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>; }
