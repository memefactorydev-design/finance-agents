import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal, type Principal } from "@/lib/core/auth";
import { FinanceError } from "@/lib/core/domain";
import { financeError, sameOrigin } from "@/lib/core/server";
import { requireProject, setProjectExtraCosts } from "@/lib/crm/projects";
import { contractGross, contractNet, invoiceTotal, resolveSchedule, scheduleTotals } from "@/lib/crm/schedule";
import { EXTRA_COST_CATEGORIES, PAYMENT_CONFIRMATION_SOURCES, PAYMENT_METHODS, SCHEDULE_KEYS, type Project } from "@/lib/crm/types";
import { deleteInvoice, editInvoice, financeDefaults, lineOut, markInvoicePaid, NO_EMAIL_NOTE, raiseScheduleInvoice, reconcileInvoices, recordPayment, scheduleView, setInvoiceStatus, setOrderFinance } from "@/lib/finance/invoices";
export const dynamic = "force-dynamic";

// One project's money.
//   GET   — resolved schedule, totals, invoices, payments, reconciliation
//   PATCH — order finance (net value, VAT, installation, line overrides)
//   POST  — {action, …}: set_order_finance · record_payment (payment) ·
//           raise_invoice (raise) · mark_invoice_paid (mark_paid) · edit_invoice
//           (edit) · set_invoice_status (status) · delete_invoice (delete) ·
//           add_extra_cost · remove_extra_cost. Every POST answers with the
//           merged project and its resolved schedule so the UI replaces state.
// A receipt (record_payment / mark_invoice_paid) REQUIRES confirmation
// {source, ref?}; nothing is emailed to the client; the final QuickBooks
// invoice is human-only.
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const CONFIRMATION = z.object({ source: z.enum(PAYMENT_CONFIRMATION_SOURCES), by: z.string().max(120).optional(), at: z.string().optional(), ref: z.string().max(200).nullable().optional() });
const actorOf = (p: Principal) => ({ id: p.id, name: actorName(p) });
const elevated = (p: Principal) => p.role === "admin";

async function scheduleOut(project: Project) {
  const defaults = await financeDefaults();
  const lines = resolveSchedule(project, { defaults });
  return { project, schedule: { lines, totals: scheduleTotals(lines), contractGross: contractGross(project, defaults), contractNet: contractNet(project) } };
}

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    await requirePrincipal(request);
    const project = await requireProject(params.id);
    const defaults = await financeDefaults();
    const { lines, totals } = scheduleView(project, defaults);
    return NextResponse.json({ projectId: project.id, project, wonValue: project.wonValue, orderFinance: project.orderFinance ?? null, contract: { net: contractNet(project), gross: contractGross(project, defaults) }, totals, schedule: lines.map(lineOut), invoices: (project.invoices || []).map((i) => ({ ...i, total: invoiceTotal(i) })), payments: project.payments || [], extraCosts: project.extraCosts || [], reconciliation: reconcileInvoices(project, { defaults }), defaults }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}

const orderFinancePatch = z.object({
  netValue: z.number().min(0).optional(),
  vatRate: z.number().min(0).max(100).optional(),
  installation: z.object({ value: z.number().min(0).nullable(), retentionApplies: z.boolean().optional(), vatRate: z.number().min(0).max(100).nullable().optional() }).nullable().optional(),
  lineOverrides: z.array(z.object({ key: z.enum(SCHEDULE_KEYS), pct: z.number().min(0).max(100).nullable().optional(), amountGross: z.number().min(0).nullable().optional(), dueDate: ISO_DATE.nullable().optional(), reset: z.boolean().optional() })).optional(),
});
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const p = await requirePrincipal(request);
    sameOrigin(request);
    const r = await setOrderFinance(params.id, orderFinancePatch.parse(await request.json()), actorOf(p));
    return NextResponse.json({ ...(await scheduleOut(r.project)), wonValue: r.project.wonValue, orderFinance: r.orderFinance });
  } catch (e) { return financeError(e); }
}

const ALIASES: Record<string, string> = { payment: "record_payment", raise: "raise_invoice", mark_paid: "mark_invoice_paid", edit: "edit_invoice", status: "set_invoice_status", delete: "delete_invoice" };
const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_order_finance") }).merge(orderFinancePatch),
  z.object({ action: z.literal("record_payment"), amount: z.number().positive(), date: ISO_DATE.optional(), method: z.enum(PAYMENT_METHODS).optional(), scheduleKey: z.enum(SCHEDULE_KEYS).nullable().optional(), note: z.string().max(500).optional(), confirmation: CONFIRMATION.optional() }),
  z.object({ action: z.literal("raise_invoice"), scheduleKey: z.enum(SCHEDULE_KEYS), dueDate: ISO_DATE.optional(), note: z.string().max(500).optional(), description: z.string().max(200).optional(), paymentLink: z.string().url().optional(), amountGross: z.number().positive().optional(), email: z.unknown().optional() }),
  z.object({ action: z.literal("mark_invoice_paid"), invoiceId: z.string(), paidAt: ISO_DATE.optional(), method: z.enum(PAYMENT_METHODS).optional(), note: z.string().max(300).optional(), recordPayment: z.boolean().optional(), confirmation: CONFIRMATION.optional() }),
  z.object({ action: z.literal("edit_invoice"), invoiceId: z.string(), description: z.string().trim().min(1).max(200).optional(), dueDate: ISO_DATE.nullable().optional(), paymentLink: z.string().url().nullable().optional(), note: z.string().max(500).nullable().optional(), vatRate: z.number().min(0).max(100).optional(), amountGross: z.number().positive().optional() }),
  z.object({ action: z.literal("set_invoice_status"), invoiceId: z.string(), status: z.enum(["draft", "sent", "void"]) }),
  z.object({ action: z.literal("delete_invoice"), invoiceId: z.string() }),
  z.object({ action: z.literal("add_extra_cost"), amount: z.number().positive(), date: ISO_DATE, category: z.enum(EXTRA_COST_CATEGORIES), description: z.string().min(1).max(300) }),
  z.object({ action: z.literal("remove_extra_cost"), id: z.string() }),
]);
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const p = await requirePrincipal(request);
    sameOrigin(request);
    const raw = await request.json();
    const b = action.parse({ ...raw, action: ALIASES[raw?.action] || raw?.action });
    const actor = actorOf(p);
    const id = params.id;
    switch (b.action) {
      case "set_order_finance": { const { action: _a, ...patch } = b; const r = await setOrderFinance(id, patch, actor); return NextResponse.json({ ...(await scheduleOut(r.project)), orderFinance: r.orderFinance }); }
      case "record_payment": { const r = await recordPayment({ projectId: id, amount: b.amount, date: b.date, method: b.method, scheduleKey: b.scheduleKey ?? null, note: b.note, confirmation: b.confirmation ?? null, actor }); return NextResponse.json({ ...(await scheduleOut(r.project)), payment: r.payment, invoicesAutoMarkedPaid: r.invoicesAutoMarkedPaid }, { status: 201 }); }
      case "raise_invoice": { const r = await raiseScheduleInvoice({ projectId: id, scheduleKey: b.scheduleKey, dueDate: b.dueDate, note: b.note, description: b.description, paymentLink: b.paymentLink, amountGross: b.amountGross, elevated: elevated(p), actor }); return NextResponse.json({ ...(await scheduleOut(r.project)), invoice: { ...r.invoice, total: invoiceTotal(r.invoice) }, emailed: false, ...(b.email ? { note: NO_EMAIL_NOTE } : {}) }, { status: 201 }); }
      case "mark_invoice_paid": { const r = await markInvoicePaid({ projectId: id, invoiceId: b.invoiceId, paidAt: b.paidAt, method: b.method, note: b.note, recordPayment: b.recordPayment, confirmation: b.confirmation ?? null, actor }); return NextResponse.json({ ...(await scheduleOut(r.project)), invoice: { ...r.invoice, total: invoiceTotal(r.invoice) }, payment: r.payment }); }
      case "edit_invoice": { const r = await editInvoice({ projectId: id, invoiceId: b.invoiceId, description: b.description, dueDate: b.dueDate, paymentLink: b.paymentLink, note: b.note, vatRate: b.vatRate, amountGross: b.amountGross, elevated: elevated(p), actor }); return NextResponse.json({ ...(await scheduleOut(r.project)), invoice: { ...r.invoice, total: invoiceTotal(r.invoice) }, changed: r.changed }); }
      case "set_invoice_status": { const r = await setInvoiceStatus(id, b.invoiceId, b.status, actor, elevated(p)); return NextResponse.json({ ...(await scheduleOut(r.project)), invoice: { ...r.invoice, total: invoiceTotal(r.invoice) } }); }
      case "delete_invoice": { const r = await deleteInvoice({ projectId: id, invoiceId: b.invoiceId, elevated: elevated(p), actor }); return NextResponse.json({ ...(await scheduleOut(r.project)), invoice: r.invoice, removedPayments: r.removedPayments }); }
      case "add_extra_cost": {
        const current = await requireProject(id);
        const cost = { id: `X-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase(), amount: Math.round(b.amount * 100) / 100, date: b.date, category: b.category, description: b.description, addedBy: actor.name, addedAt: new Date().toISOString() };
        const project = await setProjectExtraCosts(id, [...(current.extraCosts || []), cost]);
        return NextResponse.json({ ...(await scheduleOut(project)), extraCost: cost }, { status: 201 });
      }
      case "remove_extra_cost": {
        if (!elevated(p)) throw new FinanceError("FORBIDDEN", false, 403);
        const current = await requireProject(id);
        const project = await setProjectExtraCosts(id, (current.extraCosts || []).filter((c) => c.id !== b.id));
        return NextResponse.json(await scheduleOut(project));
      }
    }
  } catch (e) { return financeError(e); }
}
