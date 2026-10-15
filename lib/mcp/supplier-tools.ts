// Supplier-side tools: QuickBooks supplier balances, the cashflow outlook,
// supplier payment terms, the supplier playbook and the dispute register.
// Profiles and disputes live in the finance store and are the source of
// truth for the payment-run, reconciliation and coding agents. The only
// QuickBooks side effects are the "[DISPUTED …]" memo on a Bill (through the
// posting gate — dry run when posting is off) and applying supplier terms
// (admin keys, posting on). Nothing here pays anyone.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { actorName, fail, ok, principalFrom, runTool, type Extra } from "./auth";
import { cashflowOutlook } from "@/lib/finance/cashflow";
import { applySupplierTerms, markBillDisputed } from "@/lib/finance/supplier-terms";
import { findSupplierProfile, listDisputes, listSupplierProfiles, raiseDispute, updateDispute, upsertSupplierProfile, type DisputeStatus, type SupplierProfile } from "@/lib/finance/suppliers";
import { vendorBalanceDetail } from "@/lib/finance/vendor-balances";

const adminOnly = (p: { role: string }) => (p.role === "admin" ? null : "Forbidden: this tool needs an admin API key");
const VENDOR_ID = z.string().regex(/^(\d+|pending:[a-z0-9][a-z0-9-]*)$/, "vendorId must be a QuickBooks Vendor Id or pending:<slug>");
const DISPUTE_STATUS = z.enum(["open", "awaiting_supplier", "credit_expected", "resolved", "withdrawn"]);
const EVIDENCE = z.object({ kind: z.enum(["email", "blob", "note", "crm", "statement"]), ref: z.string().min(1), note: z.string().optional() });
const profilePatchSchema = z.object({
  vendorName: z.string().min(1).optional(),
  aliases: z.array(z.string()).optional(),
  emailDomains: z.array(z.string()).optional(),
  contacts: z.array(z.object({ name: z.string(), email: z.string().optional(), phone: z.string().optional(), role: z.string().optional() })).optional(),
  terms: z.object({ kind: z.enum(["days", "eom_next"]), days: z.number().int().min(0).max(120) }).nullable().optional(),
  statementAccount: z.boolean().optional(),
  blockAfterDaysOverdue: z.number().int().min(0).max(120).nullable().optional(),
  safeDaysOverdue: z.number().int().min(0).max(120).nullable().optional(),
  pressure: z.enum(["low", "medium", "high", "critical"]).optional(),
  onHold: z.boolean().optional(),
  proformaOnly: z.boolean().optional(),
  paymentMethods: z.array(z.enum(["bacs", "card", "amex", "paypal"])).optional(),
  paymentLinkWording: z.string().nullable().optional(),
  allocateOldestFirst: z.boolean().optional(),
  defaultAccountName: z.string().nullable().optional(),
  categoryHints: z.record(z.string()).optional(),
  autoPost: z.boolean().optional(),
  creditLimit: z.number().nullable().optional(),
  notes: z.string().optional(),
});
const slimProfile = (p: SupplierProfile) => ({ vendorId: p.vendorId, vendorName: p.vendorName, terms: p.terms, statementAccount: p.statementAccount, blockAfterDaysOverdue: p.blockAfterDaysOverdue, safeDaysOverdue: p.safeDaysOverdue, pressure: p.pressure, onHold: p.onHold, proformaOnly: p.proformaOnly, paymentMethods: p.paymentMethods, defaultAccountName: p.defaultAccountName, autoPost: p.autoPost, creditLimit: p.creditLimit, updatedAt: p.updatedAt });

export function registerSupplierTools(server: McpServer) {
  server.registerTool("get_supplier_balances", { title: "Supplier balances (QuickBooks)", description: "QuickBooks Vendor Balance Detail parsed per supplier: every open bill / credit with due date and days overdue, net open, unapplied credits, disputed items (excluded from cash buckets), next due, and overdue / 7 / 14 / 30-day buckets. Read-only; cached 5 minutes.", inputSchema: { fresh: z.boolean().optional().describe("Bypass the cache"), vendor: z.string().optional().describe("Supplier name contains…"), limit: z.number().int().min(1).max(500).optional().default(200) }, annotations: { readOnlyHint: true } },
    async (a, extra: Extra) => runTool(async () => {
      principalFrom(extra.authInfo);
      const r = await vendorBalanceDetail({ fresh: a.fresh });
      const vendors = r.vendors.filter((v) => !a.vendor || v.vendor.toLowerCase().includes(a.vendor.toLowerCase())).slice(0, a.limit);
      return ok({ ...r, vendors });
    }));

  server.registerTool("get_cashflow_outlook", { title: "Cashflow outlook (13 weeks)", description: "QuickBooks bank book balances + expected client receipts from the project schedules − live supplier bills (disputed excluded) − standing commitments, as 13 weekly buckets with the low point, plus per-supplier pay-Friday / block-risk rows from the playbook. Provisional: the bank-feed balance is not in the QuickBooks API and receipts are unreconciled.", inputSchema: { fresh: z.boolean().optional() }, annotations: { readOnlyHint: true } },
    async (a, extra: Extra) => runTool(async () => { principalFrom(extra.authInfo); return ok(await cashflowOutlook({ fresh: a.fresh })); }));

  server.registerTool("apply_supplier_terms", { title: "Plan / apply supplier payment terms in QuickBooks", description: "Admin keys. mode 'plan' (read-only) shows which Term records would be created, which vendors match each supplier line, which open bills would be re-dated to follow the terms and which pre-cutoff bills would be marked DISPUTED (memo + CONFIG#disputed-bills, excluded from the cashflow). mode 'apply' writes it — only with QuickBooks posting on; otherwise the plan comes back as a dry run.", inputSchema: { mode: z.enum(["plan", "apply"]).default("plan"), cutoff: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), terms: z.array(z.object({ supplier: z.string().min(1), term: z.string().min(1).describe("'Net 30', '45 days', 'end of following month'") })).min(1).max(200) }, annotations: { readOnlyHint: false, destructiveHint: true } },
    async (a, extra: Extra) => runTool(async () => {
      const p = principalFrom(extra.authInfo);
      const err = adminOnly(p); if (err) return fail(err);
      return ok(await applySupplierTerms({ mode: a.mode, cutoff: a.cutoff, terms: a.terms, actor: actorName(p) }));
    }));

  server.registerTool("get_supplier_profile", { title: "Supplier profile", description: "One supplier's playbook entry: terms (days or end-of-following-month), statement account, block/safe days overdue, pressure, on hold, pro-forma only, payment methods, default QuickBooks account, autoPost, contacts, notes — plus the supplier's active disputes. Look up by QuickBooks vendorId or by name/alias/email domain.", inputSchema: { vendorId: z.string().optional().describe("QuickBooks Vendor Id or pending:<slug>"), name: z.string().optional().describe("Supplier name or alias as it appears on invoices / in QuickBooks"), emailDomain: z.string().optional().describe("Sender domain") }, annotations: { readOnlyHint: true } },
    async (a, extra: Extra) => runTool(async () => {
      principalFrom(extra.authInfo);
      if (!a.vendorId && !a.name && !a.emailDomain) return fail("Give vendorId, name or emailDomain");
      const profile = await findSupplierProfile({ vendorId: a.vendorId, name: a.name, emailDomain: a.emailDomain });
      if (!profile) return ok({ found: false, hint: "No playbook entry yet. Create one with upsert_supplier_profile (vendorId = QuickBooks id, or pending:<slug> until the vendor exists)." });
      const disputes = (await listDisputes({ status: "active" })).filter((d) => (d.vendorId && d.vendorId === profile.vendorId) || d.vendor.toLowerCase() === profile.vendorName.toLowerCase());
      return ok({ found: true, profile, activeDisputes: disputes.map((d) => ({ id: d.id, docNumber: d.docNumber, amount: d.amount, project: d.project, reason: d.reason, status: d.status, raisedAt: d.raisedAt })) });
    }));

  server.registerTool("list_supplier_profiles", { title: "Supplier playbook", description: "Every supplier playbook entry (slim): terms, statement account, block/safe days, pressure, on hold, pro-forma, payment methods, default account, autoPost. Use get_supplier_profile for contacts, aliases, domains and notes.", inputSchema: { onHold: z.boolean().optional().describe("Only suppliers on hold"), pressure: z.enum(["low", "medium", "high", "critical"]).optional() }, annotations: { readOnlyHint: true } },
    async (a, extra: Extra) => runTool(async () => {
      principalFrom(extra.authInfo);
      const rows = (await listSupplierProfiles()).filter((x) => a.onHold === undefined || x.onHold === a.onHold).filter((x) => !a.pressure || x.pressure === a.pressure);
      return ok({ total: rows.length, pending: rows.filter((x) => x.vendorId.startsWith("pending:")).length, profiles: rows.map(slimProfile) });
    }));

  server.registerTool("upsert_supplier_profile", { title: "Create or update a supplier profile", description: "Create or patch a supplier playbook entry. vendorId is the QuickBooks Vendor Id, or pending:<slug> until the vendor exists in QuickBooks. Only the fields given change; arrays replace. Record WHY in notes (statement date, email, transcript) — profiles drive the payment ladder and bill coding.", inputSchema: { vendorId: VENDOR_ID, patch: profilePatchSchema }, annotations: { readOnlyHint: false } },
    async (a, extra: Extra) => runTool(async () => {
      const p = principalFrom(extra.authInfo);
      const existing = await findSupplierProfile({ vendorId: a.vendorId });
      if (!existing && !a.patch.vendorName) return fail("New profile: patch.vendorName is required");
      const profile = await upsertSupplierProfile(a.vendorId, a.patch, actorName(p));
      return ok({ created: !existing, profile });
    }));

  server.registerTool("list_disputes", { title: "Dispute register", description: "Supplier bills under dispute. Default = active (open, awaiting_supplier, credit_expected). Disputed bills are NEVER chased, proposed for payment or counted overdue; remittances and supplier emails must say they are excluded. Filter by status or supplier name.", inputSchema: { status: z.union([DISPUTE_STATUS, z.enum(["active", "all"])]).optional().default("active"), vendor: z.string().optional().describe("Supplier name contains…"), vendorId: z.string().optional() }, annotations: { readOnlyHint: true } },
    async (a, extra: Extra) => runTool(async () => {
      principalFrom(extra.authInfo);
      const rows = await listDisputes({ status: a.status as DisputeStatus | "active" | "all", vendor: a.vendor, vendorId: a.vendorId });
      return ok({ status: a.status, total: rows.length, totalAmount: Math.round(rows.reduce((s, d) => s + d.amount, 0) * 100) / 100, disputes: rows });
    }));

  server.registerTool("raise_dispute", { title: "Raise a supplier dispute", description: "Put a supplier bill (or an un-posted invoice) into the dispute register with the reason and evidence. From then on it is excluded from cash buckets, pay runs and chasing until update_dispute resolves or withdraws it (resolution restarts the supplier's payment clock). When billId is given and QuickBooks posting is on, the Bill's memo is prefixed '[DISPUTED - reason - raised date]'; otherwise that step is reported as a dry run. Idempotent per bill.", inputSchema: { billId: z.string().optional().describe("QuickBooks Bill Id when the bill is posted"), vendorId: z.string().optional(), vendor: z.string().min(1).describe("Supplier name"), docNumber: z.string().optional().describe("Supplier invoice number"), amount: z.number().min(0).describe("Disputed amount, gross"), classId: z.string().optional(), project: z.string().optional().describe("Customer / class name"), projectId: z.string().optional(), leadId: z.string().optional(), reason: z.string().min(5), evidence: z.array(EVIDENCE).optional(), raisedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default today") }, annotations: { readOnlyHint: false } },
    async (a, extra: Extra) => runTool(async () => {
      const p = principalFrom(extra.authInfo);
      const dispute = await raiseDispute({ billId: a.billId ?? null, vendorId: a.vendorId ?? null, vendor: a.vendor, docNumber: a.docNumber ?? null, amount: a.amount, classId: a.classId ?? null, project: a.project ?? null, projectId: a.projectId ?? a.leadId ?? null, reason: a.reason, evidence: a.evidence || [], raisedAt: a.raisedAt }, actorName(p));
      const qboMemo = a.billId ? await markBillDisputed(a.billId, a.reason, dispute.raisedAt) : { state: "skipped" as const, detail: "no billId" };
      return ok({ dispute, qboMemo, reminder: "Disputed items are excluded from pay runs and chasing. Tell the supplier in writing (drafts from the accounts mailbox) and record the email as evidence with update_dispute." });
    }));

  server.registerTool("update_dispute", { title: "Update a dispute", description: "Change a dispute's status (open → awaiting_supplier → credit_expected → resolved | withdrawn), add a note or evidence, record the outcome (credit note number, agreed amount). Resolving or withdrawing stamps resolvedAt and clockRestartAt (the payment clock restarts from resolution).", inputSchema: { id: z.string().min(1), status: DISPUTE_STATUS.optional(), note: z.string().optional(), outcome: z.string().optional(), amount: z.number().min(0).optional().describe("Corrected disputed amount"), evidence: z.array(EVIDENCE).optional() }, annotations: { readOnlyHint: false } },
    async (a, extra: Extra) => runTool(async () => {
      const p = principalFrom(extra.authInfo);
      if (!a.status && !a.note && !a.outcome && a.amount === undefined && !a.evidence?.length) return fail("Nothing to update: give status, note, outcome, amount or evidence");
      return ok({ dispute: await updateDispute(a.id, { status: a.status, note: a.note, outcome: a.outcome, amount: a.amount, evidence: a.evidence }, actorName(p)) });
    }));
}
