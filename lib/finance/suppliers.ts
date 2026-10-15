// Supplier playbook, dispute register, standing commitments and manual cash
// entries. All rows live in the finance store and are the source of truth for
// the Finance UI, the MCP tools, the cashflow outlook and the reports.
// Nothing here touches QuickBooks.
import { all } from "@/lib/core/store";
import { FinanceError } from "@/lib/core/domain";
import { company, financeStore } from "@/lib/core/server";
import { normName } from "@/lib/core/text";

// ------------------------------------------------------------- supplier
export type TermsKind = "days" | "eom_next";
export type SupplierPaymentMethod = "bacs" | "card" | "amex" | "paypal";
export type Pressure = "low" | "medium" | "high" | "critical";
export interface ClassHint { classId: string; className: string; projectId: string | null; hits: number; lastSeen: string }
export interface SupplierProfile {
  vendorId: string;              // QuickBooks Vendor Id ("pending:<slug>" until the vendor exists)
  vendorName: string;
  aliases: string[];
  emailDomains: string[];
  contacts: { name: string; email?: string; phone?: string; role?: string }[];
  terms: { kind: TermsKind; days: number } | null;
  statementAccount: boolean;
  blockAfterDaysOverdue: number | null;
  safeDaysOverdue: number | null;
  pressure: Pressure;
  onHold: boolean;
  proformaOnly: boolean;
  paymentMethods: SupplierPaymentMethod[];
  paymentLinkWording: string | null;
  allocateOldestFirst: boolean;
  defaultAccountName: string | null;
  categoryHints: Record<string, string>;
  classHints: Record<string, ClassHint>;
  autoPost: boolean;
  creditLimit: number | null;
  notes: string;
  updatedBy: string;
  updatedAt: string;
}
export const DEFAULT_PROFILE: Omit<SupplierProfile, "vendorId" | "vendorName" | "updatedBy" | "updatedAt"> = {
  aliases: [], emailDomains: [], contacts: [], terms: null, statementAccount: false, blockAfterDaysOverdue: null, safeDaysOverdue: null,
  pressure: "medium", onHold: false, proformaOnly: false, paymentMethods: ["bacs"], paymentLinkWording: null, allocateOldestFirst: true,
  defaultAccountName: null, categoryHints: {}, classHints: {}, autoPost: false, creditLimit: null, notes: "",
};
const supplierKey = (vendorId: string) => `SUPPLIER#${vendorId}`;

export async function listSupplierProfiles(): Promise<SupplierProfile[]> {
  const rows = await all<SupplierProfile>(financeStore(), company(), "SUPPLIER#");
  return rows.map((r) => ({ ...DEFAULT_PROFILE, ...r.data })).sort((a, b) => a.vendorName.localeCompare(b.vendorName));
}
export async function getSupplierProfile(vendorId: string): Promise<SupplierProfile | null> {
  const row = await financeStore().get<SupplierProfile>(company(), supplierKey(vendorId));
  return row?.data ? { ...DEFAULT_PROFILE, ...row.data } : null;
}
export async function findSupplierProfile(q: { vendorId?: string | null; name?: string | null; emailDomain?: string | null; email?: string | null }): Promise<SupplierProfile | null> {
  if (q.vendorId) { const p = await getSupplierProfile(q.vendorId); if (p) return p; }
  const profiles = await listSupplierProfiles();
  const email = (q.email || "").toLowerCase();
  if (email) { const p = profiles.find((x) => x.contacts.some((c) => (c.email || "").toLowerCase() === email)); if (p) return p; }
  const domain = (q.emailDomain || "").toLowerCase();
  if (domain) { const p = profiles.find((x) => x.emailDomains.map((d) => d.toLowerCase()).includes(domain)); if (p) return p; }
  const n = normName(q.name || "");
  if (!n) return null;
  return profiles.find((x) => normName(x.vendorName) === n || x.aliases.some((a) => normName(a) === n)) || null;
}
export async function upsertSupplierProfile(vendorId: string, patch: Partial<SupplierProfile> & { vendorName?: string }, by: string): Promise<SupplierProfile> {
  const store = financeStore(), key = supplierKey(vendorId);
  const existing = await store.get<SupplierProfile>(company(), key);
  const base: SupplierProfile = existing?.data ? { ...DEFAULT_PROFILE, ...existing.data } : { ...DEFAULT_PROFILE, vendorId, vendorName: patch.vendorName || vendorId, updatedBy: by, updatedAt: new Date().toISOString() };
  const next: SupplierProfile = { ...base, ...stripUndefined(patch), vendorId, updatedBy: by, updatedAt: new Date().toISOString() };
  next.aliases = uniq(next.aliases); next.emailDomains = uniq(next.emailDomains.map((d) => d.toLowerCase()));
  await store.transact(company(), [{ key, expected: existing?.version ?? null, data: next }]);
  return next;
}
export async function deleteSupplierProfile(vendorId: string): Promise<void> {
  const store = financeStore(), key = supplierKey(vendorId);
  const existing = await store.get<SupplierProfile>(company(), key);
  if (!existing) return;
  await store.transact(company(), [{ key, expected: existing.version, data: { ...existing.data, deleted: true, vendorName: existing.data.vendorName } }]);
}
// The supplier directory the order-ack matcher and the mail classifier use.
export interface SupplierLike { id: string; name: string; norm: string; emails: string[]; domains: string[] }
export function supplierDirectory(profiles: SupplierProfile[]): SupplierLike[] {
  return profiles.map((p) => ({ id: p.vendorId, name: p.vendorName, norm: normName(p.vendorName), emails: p.contacts.map((c) => (c.email || "").toLowerCase()).filter(Boolean), domains: uniq(p.emailDomains.map((d) => d.toLowerCase())) }));
}

// ------------------------------------------------------------- disputes
export type DisputeStatus = "open" | "awaiting_supplier" | "credit_expected" | "resolved" | "withdrawn";
export interface Dispute { id: string; billId: string | null; vendorId: string | null; vendor: string; docNumber: string | null; amount: number; classId: string | null; project: string | null; projectId: string | null; reason: string; raisedAt: string; raisedBy: string; clockRestartAt: string | null; evidence: { kind: "email" | "blob" | "note" | "crm" | "statement"; ref: string; note?: string }[]; status: DisputeStatus; outcome: string | null; resolvedAt: string | null; updatedBy: string; updatedAt: string }
const disputeKey = (id: string) => `DISPUTE#${id}`;
export const ACTIVE_DISPUTE: DisputeStatus[] = ["open", "awaiting_supplier", "credit_expected"];
export async function listDisputes(filter: { status?: DisputeStatus | "active" | "all"; vendorId?: string; vendor?: string } = {}): Promise<Dispute[]> {
  const rows = await all<Dispute>(financeStore(), company(), "DISPUTE#");
  const status = filter.status || "active";
  return rows.map((r) => r.data)
    .filter((d) => status === "all" ? true : status === "active" ? ACTIVE_DISPUTE.includes(d.status) : d.status === status)
    .filter((d) => !filter.vendorId || d.vendorId === filter.vendorId)
    .filter((d) => !filter.vendor || d.vendor.toLowerCase().includes(filter.vendor.toLowerCase()))
    .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
}
export async function activeDisputedBillIds(): Promise<Set<string>> { return new Set((await listDisputes({ status: "active" })).map((d) => d.billId).filter((x): x is string => !!x)); }
export async function raiseDispute(input: Omit<Dispute, "id" | "raisedAt" | "clockRestartAt" | "status" | "outcome" | "resolvedAt" | "updatedBy" | "updatedAt" | "raisedBy" | "projectId"> & { projectId?: string | null; raisedAt?: string; id?: string; status?: DisputeStatus }, by: string): Promise<Dispute> {
  const store = financeStore();
  const id = input.id || (input.billId ? `bill-${input.billId}` : `${(input.vendorId || normName(input.vendor).replace(/\s+/g, "-")) || "vendor"}-${(input.docNumber || Date.now().toString(36)).replace(/[^A-Za-z0-9_-]/g, "")}`);
  const key = disputeKey(id);
  const existing = await store.get<Dispute>(company(), key);
  if (existing && ACTIVE_DISPUTE.includes(existing.data.status)) return existing.data;
  const now = new Date().toISOString();
  const d: Dispute = { id, billId: input.billId ?? null, vendorId: input.vendorId ?? null, vendor: input.vendor, docNumber: input.docNumber ?? null, amount: Math.round(Number(input.amount) * 100) / 100, classId: input.classId ?? null, project: input.project ?? null, projectId: input.projectId ?? null, reason: input.reason, raisedAt: input.raisedAt || now.slice(0, 10), raisedBy: by, clockRestartAt: null, evidence: input.evidence || [], status: input.status || "open", outcome: null, resolvedAt: null, updatedBy: by, updatedAt: now };
  await store.transact(company(), [{ key, expected: existing?.version ?? null, data: d }]);
  return d;
}
export async function updateDispute(id: string, patch: Partial<Pick<Dispute, "status" | "outcome" | "reason" | "amount" | "billId" | "classId" | "project" | "projectId">> & { note?: string; evidence?: Dispute["evidence"] }, by: string): Promise<Dispute> {
  const store = financeStore(), key = disputeKey(id);
  const existing = await store.get<Dispute>(company(), key);
  if (!existing) throw new FinanceError("DISPUTE_NOT_FOUND", false, 404);
  const now = new Date().toISOString();
  const d: Dispute = { ...existing.data, ...stripUndefined({ status: patch.status, outcome: patch.outcome, reason: patch.reason, amount: patch.amount, billId: patch.billId, classId: patch.classId, project: patch.project, projectId: patch.projectId }), updatedBy: by, updatedAt: now };
  if (patch.evidence?.length) d.evidence = [...d.evidence, ...patch.evidence];
  if (patch.note) d.evidence = [...d.evidence, { kind: "note", ref: now, note: patch.note }];
  if (patch.status && !ACTIVE_DISPUTE.includes(patch.status) && ACTIVE_DISPUTE.includes(existing.data.status)) { d.resolvedAt = now.slice(0, 10); d.clockRestartAt = now.slice(0, 10); }
  await store.transact(company(), [{ key, expected: existing.version, data: d }]);
  return d;
}

// --------------------------------------------- commitments, cash entries
export type Frequency = "weekly" | "monthly" | "quarterly" | "once";
export interface Commitment { id: string; kind: "loan" | "overhead" | "payroll" | "tax" | "card"; name: string; amount: number; frequency: Frequency; dueDay: number | null; nextDue: string | null; balance: number | null; endDate: string | null; notes: string; active: boolean; updatedBy: string; updatedAt: string }
export async function listCommitments(includeInactive = false): Promise<Commitment[]> {
  const rows = await all<Commitment>(financeStore(), company(), "COMMITMENT#");
  return rows.map((r) => r.data).filter((c) => includeInactive || c.active).sort((a, b) => a.name.localeCompare(b.name));
}
export async function upsertCommitment(input: Partial<Commitment> & { id?: string; name: string; kind: Commitment["kind"]; amount: number; frequency: Frequency }, by: string): Promise<Commitment> {
  const store = financeStore();
  const id = input.id || `${input.kind}-${normName(input.name).replace(/\s+/g, "-")}`;
  const key = `COMMITMENT#${id}`;
  const existing = await store.get<Commitment>(company(), key);
  const c: Commitment = { id, kind: input.kind, name: input.name, amount: input.amount, frequency: input.frequency, dueDay: input.dueDay ?? existing?.data.dueDay ?? null, nextDue: input.nextDue ?? existing?.data.nextDue ?? null, balance: input.balance ?? existing?.data.balance ?? null, endDate: input.endDate ?? existing?.data.endDate ?? null, notes: input.notes ?? existing?.data.notes ?? "", active: input.active ?? true, updatedBy: by, updatedAt: new Date().toISOString() };
  await store.transact(company(), [{ key, expected: existing?.version ?? null, data: c }]);
  return c;
}
export function commitmentDates(c: Commitment, from: string, to: string): string[] {
  const out: string[] = [];
  const push = (d: Date) => { const iso = d.toISOString().slice(0, 10); if (iso >= from && iso <= to) out.push(iso); };
  if (c.frequency === "once") { if (c.nextDue) push(new Date(c.nextDue + "T00:00:00Z")); return out; }
  const start = new Date(from + "T00:00:00Z"), end = new Date(to + "T00:00:00Z");
  if (c.frequency === "weekly") { const d = new Date(start); while (d <= end) { if (((d.getUTCDay() + 6) % 7) + 1 === (c.dueDay || 5)) push(d); d.setUTCDate(d.getUTCDate() + 1); } return out; }
  const step = c.frequency === "quarterly" ? 3 : 1;
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  if (c.nextDue) { const nd = new Date(c.nextDue + "T00:00:00Z"); d.setUTCFullYear(nd.getUTCFullYear(), nd.getUTCMonth(), 1); }
  while (d <= end) {
    const day = Math.min(c.dueDay || 1, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate());
    const due = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day));
    if (!c.endDate || due.toISOString().slice(0, 10) <= c.endDate) push(due);
    d.setUTCMonth(d.getUTCMonth() + step);
  }
  return out;
}
export type CashSection = "deposit" | "survey" | "final" | "merchant" | "finance" | "other_in" | "supplier" | "overhead" | "loan" | "wages" | "vat" | "other_out";
export const CASH_SECTIONS: CashSection[] = ["deposit", "survey", "final", "merchant", "finance", "other_in", "supplier", "overhead", "loan", "wages", "vat", "other_out"];
export const INFLOW_SECTIONS: CashSection[] = ["deposit", "survey", "final", "merchant", "finance", "other_in"];
export interface CashEntry { id: string; date: string; section: CashSection; label: string; amount: number; note: string | null; source: "agent" | "owner" | "sheet"; confirmed: boolean; createdBy: string; createdAt: string }
export async function listCashEntries(from?: string, to?: string): Promise<CashEntry[]> {
  const rows = await all<CashEntry>(financeStore(), company(), "CASH_ENTRY#");
  return rows.map((r) => r.data).filter((e) => (!from || e.date >= from) && (!to || e.date <= to)).sort((a, b) => a.date.localeCompare(b.date));
}
export async function appendCashEntry(input: Omit<CashEntry, "id" | "createdAt" | "createdBy"> & { id?: string }, by: string): Promise<CashEntry> {
  const store = financeStore();
  const id = input.id || `${input.date}-${input.section}-${normName(input.label).replace(/\s+/g, "-").slice(0, 40)}-${Math.round(input.amount * 100)}`;
  const key = `CASH_ENTRY#${id}`;
  const existing = await store.get<CashEntry>(company(), key);
  const e: CashEntry = { ...input, id, amount: Math.round(Number(input.amount) * 100) / 100, note: input.note ?? null, createdBy: by, createdAt: existing?.data.createdAt ?? new Date().toISOString() };
  await store.transact(company(), [{ key, expected: existing?.version ?? null, data: e }]);
  return e;
}
function uniq(xs: string[]) { return Array.from(new Set((xs || []).map((x) => x.trim()).filter(Boolean))); }
function stripUndefined<T extends object>(o: T): Partial<T> { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>; }
