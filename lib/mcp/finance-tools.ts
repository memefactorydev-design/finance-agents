// Finance tools for the agents: the company money position, payment
// schedules, customer invoices and receipts, order finance and the project
// P&Ls. Every API key can read and write; writes are attributed "(agent)" on
// the project. Amount changes and deleting a sent/paid invoice need an admin
// key. Hard rules: a receipt is recorded only with a confirmation of how it
// was verified; no client email is ever sent; the final customer invoice in
// QuickBooks stays a human decision.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { actorName, fail, ok, principalFrom, runTool, type Extra } from "./auth";
import { getConnections } from "@/lib/core/config";
import { getProject } from "@/lib/crm/projects";
import { contractGross, contractNet, invoiceTotal, orderGross, resolveSchedule, scheduleTotals } from "@/lib/crm/schedule";
import { PAYMENT_CONFIRMATION_SOURCES, PAYMENT_METHODS, projectName, SCHEDULE_KEYS } from "@/lib/crm/types";
import { deleteInvoice, editInvoice, financeDefaults, lineOut, markInvoicePaid, NO_EMAIL_NOTE, raiseScheduleInvoice, reconcileInvoices, recordPayment, setOrderFinance } from "@/lib/finance/invoices";
import { buildFinanceOverview, inWindow, slimOverview, type DueWindow } from "@/lib/finance/overview";
import { projectPnl } from "@/lib/finance/project-pnl";

const PROJECT_ID = { projectId: z.string().optional(), leadId: z.string().optional().describe("Alias of projectId (older briefs)") };
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const CONFIRMATION = z.object({
  source: z.enum(PAYMENT_CONFIRMATION_SOURCES).describe("How the money was verified"),
  by: z.string().max(120).optional().describe("Who confirmed it (defaults to this agent)"),
  at: z.string().optional().describe("ISO date-time of the confirmation"),
  ref: z.string().max(200).nullable().optional().describe("Statement line, payout id, terminal receipt…"),
}).describe("REQUIRED: nothing is marked paid on a client's say-so");
const idOf = (a: { projectId?: string; leadId?: string }) => a.projectId || a.leadId || "";
const elevated = (p: { role: string }) => p.role === "admin";

export function registerFinanceTools(server: McpServer) {
  server.registerTool("get_finance_overview", { title: "Finance overview", description: "Company-wide money position across every active project: contract value (net + inc VAT), taken, outstanding, overdue, due in 14/30 days, invoices by status, Sales/Order/Supplier/Completion profit, top outstanding projects and the overdue / due-soon payment lines. CRM figures, unreconciled to the bank.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async (_a, extra: Extra) => runTool(async () => { principalFrom(extra.authInfo); return ok(slimOverview(await buildFinanceOverview())); }));

  server.registerTool("list_payments_due", { title: "Payments due", description: "Scheduled client payments (deposit, survey payment, delivery balance, installation lines) that are overdue or fall due in a window, with the client, designer, amount inc VAT, due date, status and whether an invoice exists. Use raise_invoice for lines marked 'not invoiced'.", inputSchema: { window: z.enum(["overdue", "next7", "next14", "next30", "all"]).optional().default("next14"), designer: z.string().optional().describe("Designer name / email fragment"), limit: z.number().int().min(1).max(200).optional().default(50) }, annotations: { readOnlyHint: true } },
    async (a, extra: Extra) => runTool(async () => {
      principalFrom(extra.authInfo);
      const o = await buildFinanceOverview({ pnlLimit: 0, ledger: null });
      const rows = o.dueLines.filter((l) => inWindow(l, a.window as DueWindow) && (!a.designer || (l.designer || "").toLowerCase().includes(a.designer.toLowerCase()))).slice(0, a.limit);
      return ok({ window: a.window, total: rows.length, totalOutstanding: rows.reduce((s, r) => s + r.outstandingGross, 0), lines: rows });
    }));

  server.registerTool("get_payment_schedule", { title: "Payment schedule for a project", description: "Full order finance for one project: net / VAT / gross order value, installation contract, every schedule line with amount inc VAT, due date, paid and status, invoices raised and payments recorded (with their receipt confirmations).", inputSchema: PROJECT_ID, annotations: { readOnlyHint: true } },
    async (a, extra: Extra) => runTool(async () => {
      principalFrom(extra.authInfo);
      const p = await getProject(idOf(a)); if (!p) return fail(`Project ${idOf(a)} not found`);
      const defaults = await financeDefaults();
      const lines = resolveSchedule(p, { defaults });
      return ok({
        projectId: p.id, client: projectName(p), designer: p.designer || null, status: p.status, opsStage: p.opsStage || null,
        order: { net: p.wonValue || 0, vatRate: p.orderFinance?.vatRate ?? defaults.defaultVatRate, gross: orderGross(p, defaults) },
        installation: p.orderFinance?.installation || null,
        contract: { net: contractNet(p), gross: contractGross(p, defaults) },
        totals: scheduleTotals(lines), schedule: lines.map(lineOut),
        invoices: (p.invoices || []).map((i) => ({ id: i.id, number: i.number, status: i.status, date: i.date, dueDate: i.dueDate || null, total: invoiceTotal(i), scheduleKey: i.scheduleKey || null, paymentLink: i.paymentLink || null, paidAt: i.paidAt || null })),
        payments: p.payments || [],
      });
    }));

  server.registerTool("list_invoices", { title: "List invoices", description: "Customer invoices raised on projects (SI-YYYY-NNNN), optionally for one project or one status. Includes the overdue flag, the schedule line they bill and how a paid one was confirmed.", inputSchema: { ...PROJECT_ID, status: z.enum(["draft", "sent", "paid", "void", "open", "all"]).optional().default("open").describe("'open' = draft + sent"), limit: z.number().int().min(1).max(200).optional().default(50) }, annotations: { readOnlyHint: true } },
    async (a, extra: Extra) => runTool(async () => {
      principalFrom(extra.authInfo);
      const o = await buildFinanceOverview({ includeCompleted: true, pnlLimit: 0, ledger: null });
      const id = idOf(a);
      const rows = o.invoices
        .filter((r) => (!id || r.projectId === id) && (a.status === "all" ? true : a.status === "open" ? ["draft", "sent"].includes(r.invoice.status) : r.invoice.status === a.status))
        .slice(0, a.limit)
        .map((r) => ({ projectId: r.projectId, client: r.client, designer: r.designer, id: r.invoice.id, number: r.invoice.number, status: r.invoice.status, date: r.invoice.date, dueDate: r.invoice.dueDate || null, total: r.gross, for: r.lineLabel || r.invoice.items[0]?.description || null, overdue: r.overdue, paidAt: r.invoice.paidAt || null, confirmation: r.confirmation, view: `/api/finance/projects/${r.projectId}/invoices/${r.invoice.id}?format=html` }));
      return ok({ total: rows.length, invoices: rows });
    }));

  server.registerTool("raise_invoice", { title: "Raise a customer invoice", description: "Raise the numbered invoice (SI-YYYY-NNNN) for one schedule line of a project; the line is linked to it and the project updated. Nothing is emailed (emailClient is ignored and said so) — a person sends it. Fails if the line is already invoiced. amountGross (admin keys) overrides the line amount.", inputSchema: { ...PROJECT_ID, scheduleKey: z.enum(SCHEDULE_KEYS), dueDate: ISO_DATE.optional(), note: z.string().max(500).optional(), description: z.string().max(200).optional(), paymentLink: z.string().url().optional(), amountGross: z.number().positive().optional().describe("Inc VAT; admin keys only"), emailClient: z.boolean().optional().default(false).describe("Ignored: clients are never emailed by this system") }, annotations: { readOnlyHint: false, destructiveHint: false } },
    async (a, extra: Extra) => runTool(async () => {
      const p = principalFrom(extra.authInfo);
      const r = await raiseScheduleInvoice({ projectId: idOf(a), scheduleKey: a.scheduleKey, actor: { id: p.id, name: actorName(p) }, dueDate: a.dueDate, note: a.note, description: a.description, paymentLink: a.paymentLink, amountGross: a.amountGross, elevated: elevated(p) });
      return ok({ invoice: { id: r.invoice.id, number: r.invoice.number, status: r.invoice.status, total: invoiceTotal(r.invoice), dueDate: r.invoice.dueDate, scheduleKey: r.invoice.scheduleKey, view: `/api/finance/projects/${r.project.id}/invoices/${r.invoice.id}?format=html` }, emailed: false, note: a.emailClient ? NO_EMAIL_NOTE : undefined });
    }));

  server.registerTool("record_payment", { title: "Record a customer receipt", description: "Record money received (amount inc VAT) against a project, optionally tagged to the schedule line it settles; untagged receipts fill the schedule in order. Invoices on lines the receipt settles flip to paid. REQUIRES confirmation {source, by?, ref?} — bank_statement, owner, finance_provider, card_terminal or agent (on the owner's instruction in this run).", inputSchema: { ...PROJECT_ID, amount: z.number().positive(), date: ISO_DATE.optional().describe("Defaults to today"), method: z.enum(PAYMENT_METHODS).optional().default("Bank Transfer"), scheduleKey: z.enum(SCHEDULE_KEYS).optional(), note: z.string().max(500).optional(), confirmation: CONFIRMATION.optional(), confirmedBy: z.string().max(120).optional().describe("Older form: who confirmed it (recorded as source 'agent')") }, annotations: { readOnlyHint: false, destructiveHint: false } },
    async (a, extra: Extra) => runTool(async () => {
      const p = principalFrom(extra.authInfo);
      const confirmation = a.confirmation ?? (a.confirmedBy ? { source: "agent" as const, ref: a.confirmedBy } : null);
      const r = await recordPayment({ projectId: idOf(a), amount: a.amount, date: a.date, method: a.method, scheduleKey: a.scheduleKey ?? null, note: a.note, confirmation, actor: { id: p.id, name: actorName(p) } });
      const lines = resolveSchedule(r.project, { defaults: await financeDefaults() });
      return ok({ payment: r.payment, invoicesAutoMarkedPaid: r.invoicesAutoMarkedPaid, totals: scheduleTotals(lines), schedule: lines.filter((l) => l.applicable).map(lineOut) });
    }));

  server.registerTool("set_order_finance", { title: "Set order value / VAT / installation / schedule overrides", description: "Money edits on a project: net order value (ex VAT, excl. installation), VAT rate, separate installation contract (net value + retention flag), and per-line overrides (pct or absolute gross amount, due date). Omit a field to leave it unchanged. Returns the recalculated schedule.", inputSchema: { ...PROJECT_ID, netValue: z.number().min(0).optional(), vatRate: z.number().min(0).max(100).optional(), installation: z.object({ value: z.number().min(0).nullable(), retentionApplies: z.boolean().optional(), vatRate: z.number().min(0).max(100).nullable().optional() }).nullable().optional().describe("null removes the installation contract"), lineOverrides: z.array(z.object({ key: z.enum(SCHEDULE_KEYS), pct: z.number().min(0).max(100).nullable().optional(), amountGross: z.number().min(0).nullable().optional(), dueDate: ISO_DATE.nullable().optional(), reset: z.boolean().optional().describe("true = back to the default split") })).optional() }, annotations: { readOnlyHint: false, destructiveHint: false } },
    async (a, extra: Extra) => runTool(async () => {
      const p = principalFrom(extra.authInfo);
      const { projectId: _p, leadId: _l, ...patch } = a;
      const r = await setOrderFinance(idOf(a), patch, { id: p.id, name: actorName(p) });
      return ok({ wonValue: r.project.wonValue, orderFinance: r.orderFinance, contractGross: contractGross(r.project, await financeDefaults()), schedule: r.schedule.map(lineOut) });
    }));

  server.registerTool("get_project_pnl", { title: "Project P&L (Sales / Order / Supplier / Completion)", description: "The four P&Ls for a project, net of VAT: Sales (costing at sale), Order (survey-order costing, live from supplier orders until frozen), Supplier (the same orders at supplier-acknowledged prices incl. carriage and surcharges; supplierDrift = Σ acknowledged vs Σ ordered) and Completion (what the suppliers actually invoiced to the project's QuickBooks class plus extras — 'awaiting' until every supplier has invoiced), with deltas and post-completion spend.", inputSchema: PROJECT_ID, annotations: { readOnlyHint: true } },
    async (a, extra: Extra) => runTool(async () => {
      principalFrom(extra.authInfo);
      const p = await getProject(idOf(a)); if (!p) return fail(`Project ${idOf(a)} not found`);
      const cmp = await projectPnl(p);
      return ok({ projectId: p.id, client: projectName(p), netValue: p.wonValue || 0, ...cmp, costing: p.costing ?? null });
    }));

  server.registerTool("mark_invoice_paid", { title: "Mark a customer invoice paid", description: "Mark a raised invoice paid AND record the receipt on its schedule line in one step (capped at what is still outstanding on the line). Set recordPayment=false if the money was already recorded by hand. REQUIRES confirmation {source, by?, ref?} of how the receipt was verified — never on a client's say-so.", inputSchema: { ...PROJECT_ID, invoiceId: z.string(), paidAt: ISO_DATE.optional().describe("Date the money arrived; defaults to today"), method: z.enum(PAYMENT_METHODS).optional().default("Bank Transfer"), note: z.string().max(300).optional(), recordPayment: z.boolean().optional().default(true), confirmation: CONFIRMATION.optional(), confirmedBy: z.string().max(120).optional().describe("Older form: who confirmed it (recorded as source 'agent')") }, annotations: { readOnlyHint: false, destructiveHint: false } },
    async (a, extra: Extra) => runTool(async () => {
      const p = principalFrom(extra.authInfo);
      const confirmation = a.confirmation ?? (a.confirmedBy ? { source: "agent" as const, ref: a.confirmedBy } : null);
      const r = await markInvoicePaid({ projectId: idOf(a), invoiceId: a.invoiceId, actor: { id: p.id, name: actorName(p) }, paidAt: a.paidAt, method: a.method, note: a.note, recordPayment: a.recordPayment, confirmation });
      const lines = resolveSchedule(r.project, { defaults: await financeDefaults() });
      return ok({ invoice: { id: r.invoice.id, number: r.invoice.number, status: r.invoice.status, paidAt: r.invoice.paidAt, total: invoiceTotal(r.invoice) }, payment: r.payment, totals: scheduleTotals(lines), schedule: lines.filter((l) => l.applicable).map(lineOut) });
    }));

  server.registerTool("edit_invoice", { title: "Edit a draft/sent invoice", description: "Change the description, due date, payment link, note, VAT rate or (admin keys) the gross amount of an invoice that is not yet paid or void. An amount change also rewrites the schedule line.", inputSchema: { ...PROJECT_ID, invoiceId: z.string(), description: z.string().trim().min(1).max(200).optional(), dueDate: ISO_DATE.nullable().optional(), paymentLink: z.string().url().nullable().optional(), note: z.string().max(500).nullable().optional(), vatRate: z.number().min(0).max(100).optional(), amountGross: z.number().positive().optional().describe("Inc VAT; admin keys only") }, annotations: { readOnlyHint: false, destructiveHint: false } },
    async (a, extra: Extra) => runTool(async () => {
      const p = principalFrom(extra.authInfo);
      const r = await editInvoice({ projectId: idOf(a), invoiceId: a.invoiceId, actor: { id: p.id, name: actorName(p) }, elevated: elevated(p), description: a.description, dueDate: a.dueDate, paymentLink: a.paymentLink, note: a.note, vatRate: a.vatRate, amountGross: a.amountGross });
      return ok({ invoice: { id: r.invoice.id, number: r.invoice.number, status: r.invoice.status, dueDate: r.invoice.dueDate || null, total: invoiceTotal(r.invoice) }, changed: r.changed });
    }));

  server.registerTool("delete_invoice", { title: "Delete an invoice", description: "Remove an invoice from a project (draft: any key; sent/paid: admin keys). A paid invoice's auto-recorded receipt is removed with it and its schedule line is freed so it can be invoiced again. The number is never reused; the project notes keep the record. Prefer voiding an invoice the client has already received.", inputSchema: { ...PROJECT_ID, invoiceId: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true } },
    async (a, extra: Extra) => runTool(async () => {
      const p = principalFrom(extra.authInfo);
      const r = await deleteInvoice({ projectId: idOf(a), invoiceId: a.invoiceId, actor: { id: p.id, name: actorName(p) }, elevated: elevated(p) });
      return ok({ deleted: { id: r.invoice.id, number: r.invoice.number, status: r.invoice.status, total: invoiceTotal(r.invoice), scheduleKey: r.invoice.scheduleKey || null }, removedPayments: r.removedPayments.map((x) => ({ id: x.id, amount: x.amount, date: x.date, method: x.method })) });
    }));

  server.registerTool("check_invoice_totals", { title: "Check invoice totals against the order and the payments", description: "Reconcile one project's money: the order and installation contract totals vs the payment schedule lines vs the invoices raised vs the payments recorded. Returns per-group totals and a list of mismatches with the suggested fix (edit_invoice, record_payment, mark_invoice_paid, reset schedule overrides, review payments). Read-only.", inputSchema: PROJECT_ID, annotations: { readOnlyHint: true } },
    async (a, extra: Extra) => runTool(async () => {
      principalFrom(extra.authInfo);
      const p = await getProject(idOf(a)); if (!p) return fail(`Project ${idOf(a)} not found`);
      const cfg = await getConnections();
      return ok(reconcileInvoices(p, { defaults: await financeDefaults(cfg) }));
    }));
}
