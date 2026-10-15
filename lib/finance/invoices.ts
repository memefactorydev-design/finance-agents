// Customer invoices and receipts on the project money model: raise a
// numbered invoice for a schedule line, record a receipt, mark an invoice
// paid, edit, void or delete it, and reconcile a project's money against
// itself. Shared by the API routes and the MCP tools so the number sequence,
// the project overlay write and the attribution always happen together.
//
// Hard rules:
//  • A receipt is recorded, and an invoice marked paid, ONLY with a
//    confirmation of how the money was verified (bank statement, the owner,
//    the finance provider's payout, the card terminal, or an agent acting on
//    the owner's instruction). Nothing is marked paid on a client's word.
//  • These invoices live on the project overlay for the schedule; the final
//    customer invoice in QuickBooks is a human decision — never created here.
//  • No client email is ever sent from here; an "email" request is ignored
//    and the caller told so.
import { FinanceError, r2 } from "@/lib/core/domain";
import { getConnections, type Connections } from "@/lib/core/config";
import { company, financeStore } from "@/lib/core/server";
import { upsert } from "@/lib/core/store";
import { localDate } from "@/lib/core/text";
import { addProjectNote, getProject, requireProject, upsertProject } from "@/lib/crm/projects";
import { allocatePayments, FINANCE_DEFAULTS, gbp2, installGross, invoiceTotal, invoicesToAutoMarkPaid, mergeOrderFinance, netFromGross, orderGross, resolveSchedule, SCHEDULE_META, scheduleTotals, type FinanceDefaults, type ResolvedLine } from "@/lib/crm/schedule";
import { PAYMENT_CONFIRMATION_LABEL, PAYMENT_CONFIRMATION_SOURCES, projectName, type Invoice, type OrderFinance, type Payment, type PaymentConfirmation, type PaymentConfirmationSource, type PaymentMethod, type Project, type ProjectFinanceOverlay, type ScheduleKey, type ScheduleLine } from "@/lib/crm/types";

export type InvoiceErrorCode = "nothing_due" | "already_invoiced" | "not_found" | "voided" | "already_paid" | "locked" | "forbidden" | "confirmation_required" | "confirmation_invalid" | "invalid";
const INVOICE_ERROR_STATUS: Record<InvoiceErrorCode, number> = { nothing_due: 400, already_invoiced: 409, not_found: 404, voided: 409, already_paid: 409, locked: 409, forbidden: 403, confirmation_required: 422, confirmation_invalid: 422, invalid: 400 };
export class InvoiceError extends FinanceError {
  constructor(public invoiceCode: InvoiceErrorCode, message: string) {
    super(`INVOICE_${invoiceCode.toUpperCase()}`, false, INVOICE_ERROR_STATUS[invoiceCode]);
    this.message = message;
  }
}

export interface Actor { id: string; name: string }
export const INVOICE_PREFIX = "SI";
export const NO_EMAIL_NOTE = "Client emails are never sent by this system: the invoice is on the project; a person sends it.";

export async function financeDefaults(cfg?: Connections): Promise<FinanceDefaults> {
  const c = cfg ?? (await getConnections());
  return { ...FINANCE_DEFAULTS, ...c.company.finance };
}

// ---------------------------------------------------------- number sequence
// SI-YYYY-NNNN from SETTINGS#invoice_sequence; restarts at 0001 each year.
// Numbers are never reused: a deleted invoice leaves a gap.
interface SequenceRow { year: number; next: number; updatedAt: string }
export async function nextInvoiceNumber(prefix = INVOICE_PREFIX, year = Number(localDate().slice(0, 4))): Promise<string> {
  let n = 0;
  await upsert<SequenceRow>(financeStore(), company(), "SETTINGS#invoice_sequence", (cur) => {
    n = cur && cur.year === year ? cur.next : 1;
    return { year, next: n + 1, updatedAt: new Date().toISOString() };
  });
  return `${prefix}-${year}-${String(n).padStart(4, "0")}`;
}

// ------------------------------------------------------------ confirmation
export interface ConfirmationInput { source: PaymentConfirmationSource | string; by?: string | null; at?: string | null; ref?: string | null }
export function requireConfirmation(input: ConfirmationInput | null | undefined, actor: Actor): PaymentConfirmation {
  if (!input || !input.source) throw new InvoiceError("confirmation_required", `Confirm how the receipt was verified before recording it: one of ${PAYMENT_CONFIRMATION_SOURCES.join(", ")} (with a reference such as the statement line or who confirmed it)`);
  if (!(PAYMENT_CONFIRMATION_SOURCES as readonly string[]).includes(input.source)) throw new InvoiceError("confirmation_invalid", `confirmation.source must be one of ${PAYMENT_CONFIRMATION_SOURCES.join(", ")}`);
  return { source: input.source as PaymentConfirmationSource, by: (input.by || "").trim() || actor.name, at: input.at || new Date().toISOString(), ref: (input.ref || "").trim() || null };
}
export const describeConfirmation = (c: PaymentConfirmation) => `${PAYMENT_CONFIRMATION_LABEL[c.source]} — ${c.by}${c.ref ? ` (${c.ref})` : ""}`;

// ------------------------------------------------------------- overlay write
// One optimistic write for everything a money action changes (invoices and
// payments together), so the schedule and the invoice can never disagree.
async function patchFinance(id: string, patch: Partial<Pick<ProjectFinanceOverlay, "payments" | "invoices" | "orderFinance">>): Promise<Project> {
  await requireProject(id);
  await upsert<ProjectFinanceOverlay>(financeStore(), company(), `PROJECT_FINANCE#${id}`, (cur) => ({ ...(cur || { updatedAt: "" }), ...patch, updatedAt: new Date().toISOString() }));
  return (await getProject(id))!;
}
const note = (projectId: string, text: string, actor: Actor) => addProjectNote(projectId, text, actor.name).catch(() => {});
const today = () => localDate();
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
const ukDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB");

const LINE_DESCRIPTIONS: Record<ScheduleKey, string> = {
  deposit: "Deposit due on order",
  survey_payment: "Survey order payment",
  delivery_balance: "Delivery balance",
  install_deposit: "Installation deposit",
  install_day1: "Installation — payment due Day 1",
  install_stage1: "Installation — payment due on Stage 1 sign-off",
  retention: "Installation retention — released on Stage 2 sign-off",
};

// ---------------------------------------------------------------- raise
export interface RaiseInput {
  projectId: string;
  scheduleKey: ScheduleKey;
  actor: Actor;
  dueDate?: string;
  note?: string;
  paymentLink?: string;
  description?: string;
  // Admins only: raise for a different gross amount. The schedule line is
  // overridden to the same figure in the same write.
  amountGross?: number;
  elevated?: boolean;
  emailClient?: boolean;   // ignored — see NO_EMAIL_NOTE
}
export interface RaiseResult { project: Project; invoice: Invoice; line: ResolvedLine; emailed: false; note: string }

export async function raiseScheduleInvoice(input: RaiseInput): Promise<RaiseResult> {
  const project = await requireProject(input.projectId);
  const defaults = await financeDefaults();
  const lines = resolveSchedule(project, { defaults });
  const line = lines.find((l) => l.key === input.scheduleKey);
  if (!line || !line.applicable || line.amountGross <= 0) throw new InvoiceError("nothing_due", `Nothing to invoice for ${SCHEDULE_META[input.scheduleKey].label} — set the order value first`);
  if (line.invoice && line.invoice.status !== "void") throw new InvoiceError("already_invoiced", `${line.label} is already invoiced (${line.invoice.number})`);

  let amountGross = line.amountGross;
  let override: Partial<ScheduleLine> | null = null;
  if (input.amountGross !== undefined && Math.abs(input.amountGross - line.amountGross) >= 0.005) {
    if (!input.elevated) throw new InvoiceError("forbidden", "Only an admin can raise an invoice for a different amount");
    amountGross = r2(input.amountGross);
    override = { amount: amountGross, pct: null, overridden: true };
  }
  const number = await nextInvoiceNumber();
  const dueDate = input.dueDate || line.dueDate || new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const net = netFromGross(amountGross, line.vatRate);
  const invoice: Invoice = {
    id: newId("I"), number, date: today(), dueDate,
    items: [{ description: input.description?.trim() || LINE_DESCRIPTIONS[input.scheduleKey], qty: 1, unitPrice: net }],
    vatRate: line.vatRate, status: "draft", sentAt: null, note: input.note?.trim() || undefined, scheduleKey: input.scheduleKey, raisedBy: input.actor.id, paymentLink: input.paymentLink?.trim() || null,
  };
  const invoices = [...(project.invoices || []), invoice];
  const orderFinance = mergeOrderFinance(project.orderFinance, { schedule: { [input.scheduleKey]: { invoiceId: invoice.id, ...(override || {}) } } }, input.actor.id, defaults);
  const updated = await patchFinance(project.id, { invoices, orderFinance });
  await note(project.id, `Invoice ${number} raised — ${line.label} · ${gbp2(invoiceTotal(invoice))} inc VAT · due ${ukDate(dueDate)}${override ? ` · amount set by ${input.actor.name} (schedule line was ${gbp2(line.amountGross)})` : ""}`, input.actor);
  return { project: updated, invoice, line, emailed: false, note: NO_EMAIL_NOTE };
}

// --------------------------------------------------------------- receipts
export interface RecordPaymentInput {
  projectId: string;
  amount: number;
  date?: string;
  method?: PaymentMethod;
  scheduleKey?: ScheduleKey | null;
  note?: string;
  confirmation: ConfirmationInput | null | undefined;
  actor: Actor;
}
export interface RecordPaymentResult { project: Project; payment: Payment; invoicesAutoMarkedPaid: string[] }

// Untagged payments fill the schedule in order; tagged ones go to their line.
// Any draft/sent invoice whose line the receipt settles flips to paid.
export async function recordPayment(input: RecordPaymentInput): Promise<RecordPaymentResult> {
  const confirmation = requireConfirmation(input.confirmation, input.actor);
  if (!(input.amount > 0)) throw new InvoiceError("invalid", "amount must be positive (inc VAT)");
  const project = await requireProject(input.projectId);
  const payment: Payment = {
    id: newId("P"), amount: r2(input.amount), date: input.date || today(), method: input.method || "Bank Transfer",
    note: input.note?.trim() ? `${input.note.trim()} (recorded by ${input.actor.name})` : `Recorded by ${input.actor.name}`,
    scheduleKey: input.scheduleKey ?? null, confirmation,
  };
  let updated = await patchFinance(project.id, { payments: [...(project.payments || []), payment] });
  await note(project.id, `Payment recorded ${gbp2(payment.amount)} · ${payment.method}${payment.scheduleKey ? ` · ${SCHEDULE_META[payment.scheduleKey].label}` : ""} · ${describeConfirmation(confirmation)}`, input.actor);
  const reconciled = await reconcileInvoicesWithPayments(project.id, input.actor).catch(() => null);
  if (reconciled) updated = reconciled.project;
  return { project: updated, payment, invoicesAutoMarkedPaid: reconciled ? reconciled.autoPaid.map((i) => i.number) : [] };
}

export interface MarkPaidInput {
  projectId: string;
  invoiceId: string;
  actor: Actor;
  paidAt?: string;
  method?: PaymentMethod;
  note?: string;
  recordPayment?: boolean;  // default true; false when the money was already recorded by hand
  confirmation: ConfirmationInput | null | undefined;
}
export interface MarkPaidResult { project: Project; invoice: Invoice; payment: Payment | null }

// One write: the invoice becomes paid AND a gross payment lands on its
// schedule line (capped at what is still outstanding there).
export async function markInvoicePaid(input: MarkPaidInput): Promise<MarkPaidResult> {
  const confirmation = requireConfirmation(input.confirmation, input.actor);
  const project = await requireProject(input.projectId);
  const invoice = (project.invoices || []).find((i) => i.id === input.invoiceId);
  if (!invoice) throw new InvoiceError("not_found", "Invoice not found on project");
  if (invoice.status === "void") throw new InvoiceError("voided", "This invoice has been voided");
  if (invoice.status === "paid") throw new InvoiceError("already_paid", `${invoice.number} is already marked paid`);
  const defaults = await financeDefaults();
  const paidAt = input.paidAt || today();
  const total = invoiceTotal(invoice);
  let payment: Payment | null = null;
  if (input.recordPayment !== false) {
    const line = invoice.scheduleKey ? resolveSchedule(project, { defaults }).find((l) => l.key === invoice.scheduleKey) : null;
    const amount = line ? Math.min(total, line.outstandingGross) : total;
    if (amount > 0.005) payment = { id: newId("P"), amount: r2(amount), date: paidAt, method: input.method || "Bank Transfer", note: input.note?.trim() || `Invoice ${invoice.number}`, scheduleKey: invoice.scheduleKey ?? null, confirmation };
  }
  const next: Invoice = { ...invoice, status: "paid", paidAt };
  const invoices = (project.invoices || []).map((i) => (i.id === invoice.id ? next : i));
  const updated = await patchFinance(project.id, { invoices, ...(payment ? { payments: [...(project.payments || []), payment] } : {}) });
  await note(project.id, `Invoice ${invoice.number} marked paid · ${gbp2(total)} inc VAT${payment ? ` · ${gbp2(payment.amount)} ${payment.method} recorded${invoice.scheduleKey ? ` on ${SCHEDULE_META[invoice.scheduleKey].label}` : ""}` : " · no payment recorded"} · paid ${ukDate(paidAt)} · ${describeConfirmation(confirmation)}`, input.actor);
  return { project: updated, invoice: next, payment };
}

// The payment "Paid" recorded for an invoice is recognisable by its note and
// line; payments entered by hand are never touched by a delete.
export function paymentRecordedFor(invoice: Pick<Invoice, "number" | "scheduleKey">, payment: Payment): boolean {
  return (payment.note || "") === `Invoice ${invoice.number}` && (payment.scheduleKey ?? null) === (invoice.scheduleKey ?? null);
}

// After receipts are recorded by hand: any draft/sent invoice whose schedule
// line is now fully settled is flipped to paid. Null when nothing changed.
export async function reconcileInvoicesWithPayments(projectId: string, actor: Actor): Promise<{ project: Project; autoPaid: Invoice[] } | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  const defaults = await financeDefaults();
  const due = invoicesToAutoMarkPaid(project, { defaults });
  if (!due.length) return null;
  const ids = new Set(due.map((i) => i.id));
  const paidDate = (inv: Invoice) => { const tagged = (project.payments || []).filter((p) => p.scheduleKey && p.scheduleKey === inv.scheduleKey).map((p) => p.date).filter(Boolean).sort(); return tagged[tagged.length - 1] || today(); };
  const invoices = (project.invoices || []).map((i) => (ids.has(i.id) ? { ...i, status: "paid" as const, paidAt: paidDate(i) } : i));
  const updated = await patchFinance(project.id, { invoices });
  for (const inv of due) await note(project.id, `Invoice ${inv.number} auto-marked paid · ${gbp2(invoiceTotal(inv))} inc VAT · its ${inv.scheduleKey ? SCHEDULE_META[inv.scheduleKey].label : "schedule"} line is settled by the payments recorded`, actor);
  return { project: updated, autoPaid: due };
}

// ------------------------------------------------------------------ edit
export interface EditInvoiceInput { projectId: string; invoiceId: string; actor: Actor; elevated: boolean; description?: string; dueDate?: string | null; paymentLink?: string | null; note?: string | null; vatRate?: number; amountGross?: number }
export interface EditInvoiceResult { project: Project; invoice: Invoice; changed: string[] }

// Draft/sent invoices only. Admins may change the amount, which also rewrites
// the schedule line so the schedule and the invoice agree.
export async function editInvoice(input: EditInvoiceInput): Promise<EditInvoiceResult> {
  const project = await requireProject(input.projectId);
  const invoice = (project.invoices || []).find((i) => i.id === input.invoiceId);
  if (!invoice) throw new InvoiceError("not_found", "Invoice not found on project");
  if (invoice.status === "paid" || invoice.status === "void") throw new InvoiceError("locked", `A ${invoice.status} invoice can't be edited — void it and raise a new one`);
  if (input.amountGross !== undefined && !input.elevated) throw new InvoiceError("forbidden", "Only an admin can change an invoice amount");
  if (input.amountGross !== undefined && invoice.items.length !== 1) throw new InvoiceError("locked", "Amounts on multi-line invoices can't be edited here");
  const defaults = await financeDefaults();
  const changed: string[] = [];
  const items = invoice.items.map((it) => ({ ...it }));
  let vatRate = invoice.vatRate;
  if (input.vatRate !== undefined && input.vatRate !== invoice.vatRate) {
    // VAT change keeps the gross (what the client owes) constant
    const gross = invoiceTotal(invoice);
    vatRate = input.vatRate;
    if (items.length === 1) items[0].unitPrice = netFromGross(gross, vatRate) / (items[0].qty || 1);
    changed.push(`VAT ${invoice.vatRate}% → ${vatRate}%`);
  }
  if (input.amountGross !== undefined) {
    const before = invoiceTotal({ ...invoice, items, vatRate });
    if (Math.abs(before - input.amountGross) >= 0.005) { items[0].qty = 1; items[0].unitPrice = netFromGross(input.amountGross, vatRate); changed.push(`amount ${gbp2(before)} → ${gbp2(input.amountGross)}`); }
  }
  if (input.description !== undefined && input.description.trim() && input.description.trim() !== items[0]?.description) { items[0].description = input.description.trim(); changed.push("description"); }
  const next: Invoice = { ...invoice, items, vatRate };
  if (input.dueDate !== undefined && (input.dueDate || undefined) !== invoice.dueDate) { next.dueDate = input.dueDate || undefined; changed.push(`due ${invoice.dueDate || "—"} → ${input.dueDate || "—"}`); }
  if (input.paymentLink !== undefined && (input.paymentLink || null) !== (invoice.paymentLink || null)) { next.paymentLink = input.paymentLink || null; changed.push(input.paymentLink ? "payment link" : "payment link removed"); }
  if (input.note !== undefined && (input.note || undefined) !== invoice.note) { next.note = input.note || undefined; changed.push("note"); }
  if (!changed.length) return { project, invoice, changed };
  const invoices = (project.invoices || []).map((i) => (i.id === invoice.id ? next : i));
  const amountChanged = input.amountGross !== undefined && changed.some((c) => c.startsWith("amount"));
  const orderFinance = amountChanged && invoice.scheduleKey ? mergeOrderFinance(project.orderFinance, { schedule: { [invoice.scheduleKey]: { amount: invoiceTotal(next), pct: null, overridden: true } } }, input.actor.id, defaults) : undefined;
  const updated = await patchFinance(project.id, { invoices, ...(orderFinance ? { orderFinance } : {}) });
  await note(project.id, `Invoice ${invoice.number} edited · ${changed.join(" · ")}`, input.actor);
  return { project: updated, invoice: next, changed };
}

// -------------------------------------------------------- status (void etc.)
// void → admins only; the line can then be re-invoiced. draft / sent → plain
// status change (sent = a person has sent it; nothing is emailed from here).
export async function setInvoiceStatus(projectId: string, invoiceId: string, status: "draft" | "sent" | "void", actor: Actor, elevated: boolean): Promise<{ project: Project; invoice: Invoice }> {
  const project = await requireProject(projectId);
  const invoice = (project.invoices || []).find((i) => i.id === invoiceId);
  if (!invoice) throw new InvoiceError("not_found", "Invoice not found on project");
  if (status === "void" && !elevated) throw new InvoiceError("forbidden", "Only an admin can void an invoice");
  if (invoice.status === "paid") throw new InvoiceError("locked", `${invoice.number} is paid — delete it (admin) if it was marked paid in error`);
  const next: Invoice = { ...invoice, status, ...(status === "sent" && !invoice.sentAt ? { sentAt: new Date().toISOString() } : {}) };
  const invoices = (project.invoices || []).map((i) => (i.id === invoice.id ? next : i));
  const updated = await patchFinance(project.id, { invoices });
  await note(project.id, `Invoice ${invoice.number} marked ${status} · ${gbp2(invoiceTotal(invoice))} inc VAT`, actor);
  return { project: updated, invoice: next };
}

// ---------------------------------------------------------------- delete
export interface DeleteInvoiceResult { project: Project; invoice: Invoice; removedPayments: Payment[] }
// Draft invoices can be deleted by anyone on the project; sent and paid ones
// by admins. Deleting a paid invoice also removes the payment that "Paid"
// recorded for it (and only that one) and the schedule line is unlinked so it
// can be invoiced again. Numbers are never reused.
export async function deleteInvoice(input: { projectId: string; invoiceId: string; actor: Actor; elevated: boolean }): Promise<DeleteInvoiceResult> {
  const project = await requireProject(input.projectId);
  const invoice = (project.invoices || []).find((i) => i.id === input.invoiceId);
  if (!invoice) throw new InvoiceError("not_found", "Invoice not found on project");
  if (invoice.status !== "draft" && !input.elevated) throw new InvoiceError("forbidden", `Only an admin can delete a ${invoice.status} invoice — void it instead`);
  const linked = (p: Payment) => invoice.status === "paid" && paymentRecordedFor(invoice, p);
  const removedPayments = (project.payments || []).filter(linked);
  const payments = (project.payments || []).filter((p) => !linked(p));
  const invoices = (project.invoices || []).filter((i) => i.id !== invoice.id);
  const defaults = await financeDefaults();
  const key = invoice.scheduleKey;
  const orderFinance = key && project.orderFinance?.schedule?.[key]?.invoiceId === invoice.id ? mergeOrderFinance(project.orderFinance, { schedule: { [key]: { invoiceId: null } } }, input.actor.id, defaults) : undefined;
  const updated = await patchFinance(project.id, { invoices, ...(removedPayments.length ? { payments } : {}), ...(orderFinance ? { orderFinance } : {}) });
  const removedTotal = removedPayments.reduce((s, p) => s + p.amount, 0);
  await note(project.id, `Invoice ${invoice.number} deleted · ${gbp2(invoiceTotal(invoice))} inc VAT · was ${invoice.status}${removedPayments.length ? ` · ${gbp2(removedTotal)} payment recorded by Paid removed` : ""}${key ? ` · ${SCHEDULE_META[key].label} can be invoiced again` : ""}`, input.actor);
  return { project: updated, invoice, removedPayments };
}

// ---------------------------------------------------------- order finance
export interface OrderFinancePatch {
  netValue?: number;
  vatRate?: number;
  installation?: { value: number | null; retentionApplies?: boolean; vatRate?: number | null } | null;
  lineOverrides?: { key: ScheduleKey; pct?: number | null; amountGross?: number | null; dueDate?: string | null; reset?: boolean }[];
}
// The money edits on a project: net order value (ex VAT, excl. installation),
// VAT rate, the separate installation contract, and per-line overrides (pct
// or absolute gross amount, due date). Omitted fields are left alone.
export async function setOrderFinance(projectId: string, patch: OrderFinancePatch, actor: Actor): Promise<{ project: Project; orderFinance: OrderFinance; schedule: ResolvedLine[] }> {
  let project = await requireProject(projectId);
  const defaults = await financeDefaults();
  const schedule: Record<string, Partial<ScheduleLine> | null> = {};
  for (const o of patch.lineOverrides || []) {
    if (o.reset) { schedule[o.key] = { pct: null, amount: null, overridden: false, ...(o.dueDate !== undefined ? { dueDate: o.dueDate } : {}) }; continue; }
    const line: Partial<ScheduleLine> = {};
    if (o.amountGross !== undefined) { line.amount = o.amountGross; line.pct = null; line.overridden = o.amountGross != null; }
    else if (o.pct !== undefined) { line.pct = o.pct; line.amount = null; line.overridden = o.pct != null; }
    if (o.dueDate !== undefined) line.dueDate = o.dueDate;
    schedule[o.key] = line;
  }
  const orderFinance = mergeOrderFinance(project.orderFinance, {
    ...(patch.vatRate !== undefined ? { vatRate: patch.vatRate } : {}),
    ...(patch.installation !== undefined ? { installation: patch.installation === null ? null : { value: patch.installation.value, vatRate: patch.installation.vatRate ?? project.orderFinance?.installation?.vatRate ?? null, retentionApplies: patch.installation.retentionApplies ?? project.orderFinance?.installation?.retentionApplies ?? false } } : {}),
    schedule: schedule as never,
  }, actor.id, defaults);
  // The net order value is a CRM-owned field: it goes on the project record
  // itself (a CRM re-sync may bring its own value back).
  if (patch.netValue !== undefined) project = await upsertProject({ ...project, wonValue: r2(patch.netValue) }, actor.name);
  const updated = await patchFinance(project.id, { orderFinance });
  await note(project.id, `Order finance updated by ${actor.name}: ${Object.keys(patch).join(", ")}`, actor);
  return { project: updated, orderFinance, schedule: resolveSchedule(updated, { defaults }) };
}

// ------------------------------------------------------------- reconcile
// One project's money, checked against itself: the contract totals (order +
// installation, inc VAT) must equal the schedule lines; every invoice must
// carry its line's amount; a paid invoice must have its money on the line;
// the payments must not exceed the schedule. Pure.
export type ReconcileProject = Parameters<typeof resolveSchedule>[0];
export interface GroupTotals { group: "order" | "installation"; label: string; contractGross: number; scheduledGross: number; invoicedGross: number; paidGross: number; outstandingGross: number; invoices: number; ok: boolean }
export type ReconcileIssueKind = "schedule_total" | "invoice_line" | "orphan_invoice" | "paid_short" | "settled_open" | "overpaid" | "unallocated" | "legacy_invoice";
export type ReconcileFix = "edit_invoice" | "record_payment" | "mark_paid" | "reset_overrides" | "review_payments";
export interface ReconcileIssue { kind: ReconcileIssueKind; severity: "warn" | "info"; group?: "order" | "installation"; key?: ScheduleKey; invoiceId?: string; invoiceNumber?: string; delta: number; message: string; fix?: ReconcileFix }
export interface InvoiceReconciliation { order: GroupTotals; installation: GroupTotals | null; totals: { contractGross: number; scheduledGross: number; invoicedGross: number; paidGross: number; outstandingGross: number }; legacyInvoicedGross: number; unallocatedGross: number; issues: ReconcileIssue[]; ok: boolean; checkedAt: string }
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

function groupTotals(group: "order" | "installation", contract: number, lines: ResolvedLine[], invoices: Invoice[]): GroupTotals {
  const rows = lines.filter((l) => l.group === group && l.applicable);
  const scheduled = r2(rows.reduce((s, l) => s + l.amountGross, 0));
  const inGroup = invoices.filter((i) => i.scheduleKey && SCHEDULE_META[i.scheduleKey].group === group);
  return { group, label: group === "order" ? "Order" : "Installation", contractGross: r2(contract), scheduledGross: scheduled, invoicedGross: r2(inGroup.reduce((s, i) => s + invoiceTotal(i), 0)), paidGross: r2(rows.reduce((s, l) => s + l.paidGross, 0)), outstandingGross: r2(rows.reduce((s, l) => s + l.outstandingGross, 0)), invoices: inGroup.length, ok: contract <= 0 ? scheduled === 0 : near(scheduled, contract) };
}

export function reconcileInvoices(project: ReconcileProject, opts: { defaults?: FinanceDefaults; today?: string } = {}): InvoiceReconciliation {
  const defaults = opts.defaults || FINANCE_DEFAULTS;
  const lines = resolveSchedule(project, { defaults, today: opts.today });
  const byKey = Object.fromEntries(lines.map((l) => [l.key, l])) as Record<ScheduleKey, ResolvedLine>;
  const invoices = (project.invoices || []).filter((i) => i.status !== "void");
  const oGross = orderGross(project, defaults);
  const iGross = installGross(project, defaults);
  const hasInstall = !!project.orderFinance?.installation && iGross > 0;
  const order = groupTotals("order", oGross, lines, invoices);
  const installation = hasInstall ? groupTotals("installation", iGross, lines, invoices) : null;
  const issues: ReconcileIssue[] = [];
  for (const g of [order, installation]) {
    if (!g || g.ok) continue;
    const delta = r2(g.scheduledGross - g.contractGross);
    issues.push({ kind: "schedule_total", severity: "warn", group: g.group, delta, message: `${g.label} lines add up to ${gbp2(g.scheduledGross)} but the contract is ${gbp2(g.contractGross)} inc VAT (${delta > 0 ? "+" : ""}${gbp2(delta)}) — a manual line amount no longer fits`, fix: "reset_overrides" });
  }
  for (const inv of invoices) {
    const total = invoiceTotal(inv);
    if (!inv.scheduleKey) { issues.push({ kind: "legacy_invoice", severity: "info", invoiceId: inv.id, invoiceNumber: inv.number, delta: 0, message: `${inv.number} (${gbp2(total)}) is not linked to a schedule line — payments against it fill the schedule in order` }); continue; }
    const line = byKey[inv.scheduleKey];
    const label = SCHEDULE_META[inv.scheduleKey].label;
    if (line.invoiceId !== inv.id) { issues.push({ kind: "orphan_invoice", severity: "warn", group: line.group, key: inv.scheduleKey, invoiceId: inv.id, invoiceNumber: inv.number, delta: r2(total - line.amountGross), message: `${inv.number} is for ${label} but that line is ${line.invoice ? `linked to ${line.invoice.number}` : "not linked to it"} — void or delete the one that should not count` }); continue; }
    if (!near(total, line.amountGross)) issues.push({ kind: "invoice_line", severity: "warn", group: line.group, key: inv.scheduleKey, invoiceId: inv.id, invoiceNumber: inv.number, delta: r2(total - line.amountGross), message: `${inv.number} is ${gbp2(total)} but the ${label} line is ${gbp2(line.amountGross)}`, fix: "edit_invoice" });
    if (inv.status === "paid" && line.paidGross + 0.005 < total) issues.push({ kind: "paid_short", severity: "warn", group: line.group, key: inv.scheduleKey, invoiceId: inv.id, invoiceNumber: inv.number, delta: r2(line.paidGross - total), message: `${inv.number} is marked paid but only ${gbp2(line.paidGross)} of ${gbp2(total)} is recorded on ${label}`, fix: "record_payment" });
    if ((inv.status === "draft" || inv.status === "sent") && line.paidGross + 0.005 >= total && total > 0) issues.push({ kind: "settled_open", severity: "warn", group: line.group, key: inv.scheduleKey, invoiceId: inv.id, invoiceNumber: inv.number, delta: r2(line.paidGross - total), message: `${label} is settled by the payments recorded but ${inv.number} still reads ${inv.status}`, fix: "mark_paid" });
  }
  for (const line of lines) {
    if (!line.applicable) continue;
    if (line.paidGross > line.amountGross + 0.005) issues.push({ kind: "overpaid", severity: "warn", group: line.group, key: line.key, delta: r2(line.paidGross - line.amountGross), message: `${line.label} has ${gbp2(line.paidGross)} recorded against ${gbp2(line.amountGross)} — ${gbp2(line.paidGross - line.amountGross)} too much`, fix: "review_payments" });
  }
  const { unallocated } = allocatePayments(project.payments as Payment[] | null | undefined, lines.map((l) => ({ key: l.key, amountGross: l.amountGross, applicable: l.applicable })));
  if (unallocated > 0.005) issues.push({ kind: "unallocated", severity: "warn", delta: r2(unallocated), message: `${gbp2(unallocated)} of recorded payments exceeds the whole schedule — check for a duplicate payment or a missing contract value`, fix: "review_payments" });
  const sum = (f: (g: GroupTotals) => number) => r2(f(order) + (installation ? f(installation) : 0));
  return {
    order, installation,
    totals: { contractGross: sum((g) => g.contractGross), scheduledGross: sum((g) => g.scheduledGross), invoicedGross: sum((g) => g.invoicedGross), paidGross: sum((g) => g.paidGross), outstandingGross: sum((g) => g.outstandingGross) },
    legacyInvoicedGross: r2(invoices.filter((i) => !i.scheduleKey).reduce((s, i) => s + invoiceTotal(i), 0)),
    unallocatedGross: r2(unallocated), issues, ok: !issues.some((i) => i.severity === "warn"), checkedAt: new Date().toISOString(),
  };
}

// Clears manual amount / % overrides on lines that are not invoiced, so the
// default split re-balances the group to the contract.
export function resetScheduleOverridesPatch(project: ReconcileProject, group?: "order" | "installation"): Partial<Record<ScheduleKey, { amount: null; pct: null; overridden: false }>> {
  const patch: Partial<Record<ScheduleKey, { amount: null; pct: null; overridden: false }>> = {};
  for (const [k, l] of Object.entries(project.orderFinance?.schedule || {})) {
    const key = k as ScheduleKey;
    if (group && SCHEDULE_META[key].group !== group) continue;
    if (!l || (l.amount == null && l.pct == null)) continue;
    const invoiced = l.invoiceId && (project.invoices || []).some((i) => i.id === l.invoiceId && i.status !== "void");
    if (invoiced) continue;
    patch[key] = { amount: null, pct: null, overridden: false };
  }
  return patch;
}

// ---------------------------------------------------------- schedule view
export function scheduleView(project: Project, defaults: FinanceDefaults) {
  const lines = resolveSchedule(project, { defaults });
  return { lines, totals: scheduleTotals(lines) };
}
export const lineOut = (l: ResolvedLine) => ({
  key: l.key, label: l.label, group: l.group, applicable: l.applicable, pct: l.pct,
  amountGross: l.amountGross, amountNet: l.amountNet, vat: l.vat, dueDate: l.dueDate, dueSource: l.dueSource,
  paidGross: l.paidGross, outstandingGross: l.outstandingGross, status: l.status, overridden: l.overridden,
  invoice: l.invoice ? { id: l.invoice.id, number: l.invoice.number, status: l.invoice.status, total: invoiceTotal(l.invoice), dueDate: l.invoice.dueDate || null } : null,
});

// ------------------------------------------------------------- print view
// A plain HTML rendering of one invoice for printing or saving as PDF from
// the browser. No PDF generation and no sending happens server-side.
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
export function invoiceHtml(project: Project, invoice: Invoice, cfg: Connections): string {
  const money = (v: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: cfg.company.currency || "GBP" }).format(v || 0);
  const net = r2(invoice.items.reduce((s, i) => s + i.qty * i.unitPrice, 0));
  const vat = r2(net * (invoice.vatRate / 100));
  const rows = invoice.items.map((i) => `<tr><td>${esc(i.description)}</td><td class="n">${i.qty}</td><td class="n">${money(i.unitPrice)}</td><td class="n">${money(r2(i.qty * i.unitPrice))}</td></tr>`).join("");
  const status = invoice.status === "paid" ? `PAID${invoice.paidAt ? ` ${ukDate(invoice.paidAt)}` : ""}` : invoice.status === "void" ? "VOID" : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(invoice.number)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;color:#111;max-width:760px;margin:32px auto;padding:0 16px}h1{font-size:22px;margin:0}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}.n{text-align:right}.tot td{font-weight:bold}.meta{color:#555;font-size:13px}.stamp{float:right;border:2px solid #b00;color:#b00;padding:4px 10px;font-weight:bold}@media print{body{margin:0}}</style></head><body>
${status ? `<div class="stamp">${esc(status)}</div>` : ""}
<h1>${esc(cfg.company.name || "Invoice")}</h1>
<div class="meta">${cfg.company.vatNumber ? `VAT ${esc(cfg.company.vatNumber)}` : ""}</div>
<p><strong>Invoice ${esc(invoice.number)}</strong><br>Date ${ukDate(invoice.date)}${invoice.dueDate ? ` · Due ${ukDate(invoice.dueDate)}` : ""}</p>
<p><strong>${esc(projectName(project))}</strong>${project.address ? `<br>${esc(project.address)}` : ""}${project.postcode ? `<br>${esc(project.postcode)}` : ""}</p>
<table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Unit (net)</th><th class="n">Net</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="3" class="n">Net</td><td class="n">${money(net)}</td></tr><tr><td colspan="3" class="n">VAT ${invoice.vatRate}%</td><td class="n">${money(vat)}</td></tr><tr class="tot"><td colspan="3" class="n">Total</td><td class="n">${money(r2(net + vat))}</td></tr></tfoot></table>
${invoice.paymentLink ? `<p>Pay online: <a href="${esc(invoice.paymentLink)}">${esc(invoice.paymentLink)}</a></p>` : ""}
${invoice.note ? `<p class="meta">${esc(invoice.note)}</p>` : ""}
<p class="meta">Please quote ${esc(invoice.number)} with your payment.</p>
</body></html>`;
}
