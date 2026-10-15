import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal, type Principal } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { requireProject } from "@/lib/crm/projects";
import { contractGross, contractNet, invoiceTotal } from "@/lib/crm/schedule";
import { PAYMENT_CONFIRMATION_SOURCES, PAYMENT_METHODS, SCHEDULE_KEYS } from "@/lib/crm/types";
import { deleteInvoice, editInvoice, financeDefaults, lineOut, markInvoicePaid, NO_EMAIL_NOTE, raiseScheduleInvoice, reconcileInvoices, recordPayment, scheduleView, setInvoiceStatus, setOrderFinance } from "@/lib/finance/invoices";
export const dynamic = "force-dynamic";

// One project's money.
//   GET   — resolved schedule, totals, invoices, payments, reconciliation
//   PATCH — order finance (net value, VAT, installation, line overrides)
//   POST  — {action: "payment" | "raise" | "mark_paid" | "edit" | "status" | "delete", …}
// A receipt (payment / mark_paid) REQUIRES confirmation {source, by?, ref?}.
// Nothing is emailed to the client; the final QuickBooks invoice is human-only.
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const CONFIRMATION = z.object({ source: z.enum(PAYMENT_CONFIRMATION_SOURCES), by: z.string().max(120).optional(), at: z.string().optional(), ref: z.string().max(200).nullable().optional() });
const actorOf = (p: Principal) => ({ id: p.id, name: actorName(p) });
const elevated = (p: Principal) => p.role === "admin";

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    await requirePrincipal(request);
    const project = await requireProject(params.id);
    const defaults = await financeDefaults();
    const { lines, totals } = scheduleView(project, defaults);
    return NextResponse.json({ projectId: project.id, wonValue: project.wonValue, orderFinance: project.orderFinance ?? null, contract: { net: contractNet(project), gross: contractGross(project, defaults) }, totals, schedule: lines.map(lineOut), invoices: (project.invoices || []).map((i) => ({ ...i, total: invoiceTotal(i) })), payments: project.payments || [], reconciliation: reconcileInvoices(project, { defaults }), defaults }, { headers: { "Cache-Control": "private, no-store" } });
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
    return NextResponse.json({ wonValue: r.project.wonValue, orderFinance: r.orderFinance, contractGross: contractGross(r.project, await financeDefaults()), schedule: r.schedule.map(lineOut) });
  } catch (e) { return financeError(e); }
}

const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("payment"), amount: z.number().positive(), date: ISO_DATE.optional(), method: z.enum(PAYMENT_METHODS).optional(), scheduleKey: z.enum(SCHEDULE_KEYS).nullable().optional(), note: z.string().max(500).optional(), confirmation: CONFIRMATION.optional() }),
  z.object({ action: z.literal("raise"), scheduleKey: z.enum(SCHEDULE_KEYS), dueDate: ISO_DATE.optional(), note: z.string().max(500).optional(), description: z.string().max(200).optional(), paymentLink: z.string().url().optional(), amountGross: z.number().positive().optional(), email: z.unknown().optional() }),
  z.object({ action: z.literal("mark_paid"), invoiceId: z.string(), paidAt: ISO_DATE.optional(), method: z.enum(PAYMENT_METHODS).optional(), note: z.string().max(300).optional(), recordPayment: z.boolean().optional(), confirmation: CONFIRMATION.optional() }),
  z.object({ action: z.literal("edit"), invoiceId: z.string(), description: z.string().trim().min(1).max(200).optional(), dueDate: ISO_DATE.nullable().optional(), paymentLink: z.string().url().nullable().optional(), note: z.string().max(500).nullable().optional(), vatRate: z.number().min(0).max(100).optional(), amountGross: z.number().positive().optional() }),
  z.object({ action: z.literal("status"), invoiceId: z.string(), status: z.enum(["draft", "sent", "void"]) }),
  z.object({ action: z.literal("delete"), invoiceId: z.string() }),
]);
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const p = await requirePrincipal(request);
    sameOrigin(request);
    const b = action.parse(await request.json());
    const actor = actorOf(p);
    const id = params.id;
    switch (b.action) {
      case "payment": { const r = await recordPayment({ projectId: id, amount: b.amount, date: b.date, method: b.method, scheduleKey: b.scheduleKey ?? null, note: b.note, confirmation: b.confirmation ?? null, actor }); return NextResponse.json({ payment: r.payment, invoicesAutoMarkedPaid: r.invoicesAutoMarkedPaid, ...scheduleOut(r.project, await financeDefaults()) }, { status: 201 }); }
      case "raise": { const r = await raiseScheduleInvoice({ projectId: id, scheduleKey: b.scheduleKey, dueDate: b.dueDate, note: b.note, description: b.description, paymentLink: b.paymentLink, amountGross: b.amountGross, elevated: elevated(p), actor }); return NextResponse.json({ invoice: { ...r.invoice, total: invoiceTotal(r.invoice) }, emailed: false, ...(b.email ? { note: NO_EMAIL_NOTE } : {}), ...scheduleOut(r.project, await financeDefaults()) }, { status: 201 }); }
      case "mark_paid": { const r = await markInvoicePaid({ projectId: id, invoiceId: b.invoiceId, paidAt: b.paidAt, method: b.method, note: b.note, recordPayment: b.recordPayment, confirmation: b.confirmation ?? null, actor }); return NextResponse.json({ invoice: { ...r.invoice, total: invoiceTotal(r.invoice) }, payment: r.payment, ...scheduleOut(r.project, await financeDefaults()) }); }
      case "edit": { const r = await editInvoice({ projectId: id, invoiceId: b.invoiceId, description: b.description, dueDate: b.dueDate, paymentLink: b.paymentLink, note: b.note, vatRate: b.vatRate, amountGross: b.amountGross, elevated: elevated(p), actor }); return NextResponse.json({ invoice: { ...r.invoice, total: invoiceTotal(r.invoice) }, changed: r.changed }); }
      case "status": { const r = await setInvoiceStatus(id, b.invoiceId, b.status, actor, elevated(p)); return NextResponse.json({ invoice: { ...r.invoice, total: invoiceTotal(r.invoice) } }); }
      case "delete": { const r = await deleteInvoice({ projectId: id, invoiceId: b.invoiceId, elevated: elevated(p), actor }); return NextResponse.json({ ok: true, invoice: r.invoice, removedPayments: r.removedPayments }); }
    }
  } catch (e) { return financeError(e); }
}
function scheduleOut(project: Awaited<ReturnType<typeof requireProject>>, defaults: Awaited<ReturnType<typeof financeDefaults>>) {
  const { lines, totals } = scheduleView(project, defaults);
  return { totals, schedule: lines.filter((l) => l.applicable).map(lineOut) };
}
