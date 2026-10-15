// Supplier-invoice intake tools for the finance agents (F1 triage, F8 coding
// and posting, F7 reconciliation). Any API key may read and act; only an admin
// key may flip the owner's autopilot switch. With QuickBooks posting off every
// post is a dry run and the tool says so in the result. The learning loop
// (coding decisions, class hints, auto-post promotion) lives in
// lib/finance/intake/learning.ts.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { actorName, fail, ok, principalFrom, runTool, type Extra } from "./auth";
import { getConnections } from "@/lib/core/config";
import { postingEnabled } from "@/lib/qbo/client";
import { listIntake, getIntake, postIntake, holdIntake, rejectIntake, reprocessIntake, runIntakeJob, createRedirectNotices, editPostedIntake, autopilotVerdict, type IntakeRecord } from "@/lib/finance/intake/intake";
import { buildIntakeLog, sendIntakeLog, intakeLogRecipients } from "@/lib/finance/intake/log";
import { learnSupplierDefaults } from "@/lib/finance/intake/learn";
import { getAutopilot, setAutopilot, listDecisions, decisionStats } from "@/lib/finance/intake/learning";
import { requestOwnerApprovals, applyOwnerReplies } from "@/lib/finance/intake/approvals";

const sha = z.string().regex(/^[a-f0-9]{64}$/, "sha256 hex");
const overridesSchema = z.object({
  vendorId: z.string().optional().describe("QuickBooks Vendor id"),
  docNumber: z.string().max(60).optional(),
  txnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  classId: z.string().optional().describe("QuickBooks Class id (customer / project) for every line"),
  allowNoClass: z.boolean().optional().describe("Overhead bill: post with no class"),
  lines: z.array(z.object({ accountId: z.string().optional(), classId: z.string().nullable().optional(), taxCodeId: z.string().optional(), amount: z.number().optional(), description: z.string().max(200).optional() })).optional().describe("Per-line overrides, same order as the resolved lines"),
}).optional();

const slim = (r: IntakeRecord) => ({
  sha256: r.sha256, state: r.state, confidence: r.confidence, reasons: r.reasons,
  received: r.arrivals[0]?.receivedAt || r.createdAt, arrivals: r.arrivals.map((a) => ({ mailbox: a.mailbox, from: a.from, subject: a.subject, fileName: a.fileName, receivedAt: a.receivedAt, messageId: a.messageId, attachmentId: a.attachmentId })),
  documentType: r.extraction?.documentType || null, supplierOnDocument: r.extraction?.supplierIdentity || null,
  vendor: r.resolution ? { id: r.resolution.vendorId, name: r.resolution.vendorName, score: r.resolution.vendorScore, source: r.resolution.vendorSource, proposed: r.resolution.vendorProposed || null } : null,
  docNumber: r.resolution?.docNumber || r.extraction?.documentNumber || null, txnDate: r.resolution?.txnDate || null, dueDate: r.resolution?.dueDate || null, termName: r.resolution?.termName || null, dateNote: r.resolution?.dateNote || null,
  totals: r.resolution?.totals || null, class: r.resolution ? { id: r.resolution.classId, name: r.resolution.className, score: r.resolution.classScore, candidates: r.resolution.classCandidates, projectId: r.resolution.projectId, matchedPo: r.resolution.matchedPo } : null,
  lines: r.resolution?.lines || [], qbo: r.qbo, ownerApproval: r.ownerApproval ?? null, decidedBy: r.decidedBy, decidedAt: r.decidedAt,
  pdf: `/api/finance/intake/${r.sha256}/pdf`,
});

export function registerIntakeTools(server: McpServer) {
  server.registerTool("list_supplier_invoices", {
    title: "Supplier invoices in intake",
    description: "Supplier invoice PDFs found in the intake mailboxes with their extraction, proposed QuickBooks coding (vendor, class = customer / project, account, VAT, due date), confidence and the reasons they were not auto-posted. state: open (proposed + held, default) | proposed | held | posted | duplicate | not_invoice | rejected | all.",
    inputSchema: { state: z.enum(["open", "proposed", "held", "posted", "duplicate", "not_invoice", "rejected", "all"]).optional().default("open"), vendor: z.string().optional().describe("Filter by vendor / supplier name (contains)"), limit: z.number().int().min(1).max(200).optional().default(50) },
    annotations: { readOnlyHint: true },
  }, async (args, extra: Extra) => runTool(async () => {
    principalFrom(extra.authInfo);
    const posting = await postingEnabled();
    const rows = await listIntake({ state: args.state, vendor: args.vendor, limit: args.limit });
    return ok({ posting, note: posting ? "QuickBooks posting is on: post_supplier_invoice creates real bills." : "Dry-run mode: post_supplier_invoice records the exact QuickBooks payload and creates nothing.", total: rows.length, invoices: rows.map(slim) });
  }));

  server.registerTool("get_supplier_invoice", {
    title: "One supplier invoice (full detail)",
    description: "Full intake record for one PDF by sha256: every arrival, the extraction (lines, quotes), the resolved coding with scores and candidates, reasons, owner approval, and QuickBooks ids or the dry-run payload. For a proposed item also what the autopilot would do right now.",
    inputSchema: { sha256: sha },
    annotations: { readOnlyHint: true },
  }, async (args, extra: Extra) => runTool(async () => {
    principalFrom(extra.authInfo);
    const r = await getIntake(args.sha256);
    if (!r) return fail(`No intake record ${args.sha256}`);
    const autopilot = r.state === "proposed" ? await autopilotVerdict(r).catch(() => null) : null;
    return ok({ ...slim(r), autopilot, extraction: r.extraction, extractionError: r.extractionError, extractionSource: r.extractionSource ?? null, evidence: r.evidence });
  }));

  server.registerTool("post_supplier_invoice", {
    title: "Post a supplier invoice to QuickBooks",
    description: "Create the QuickBooks Bill (vendor, lines with account / class / VAT, due date from terms) and attach the PDF for one intake item, with optional overrides for vendor, class, per-line account / VAT, dates and document number. Blocked while reasons remain unless overridden; a new supplier needs the owner's APPROVE first. With posting off (or dryRun=true) nothing is created: the exact payload is stored on the record as qbo.dryRun.",
    inputSchema: { sha256: sha, overrides: overridesSchema, dryRun: z.boolean().optional().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args, extra: Extra) => runTool(async () => {
    const p = principalFrom(extra.authInfo);
    const r = await postIntake(args.sha256, { overrides: args.overrides, by: actorName(p), dryRun: args.dryRun });
    const posting = (await postingEnabled()) && !args.dryRun;
    return ok({ posting, result: r.state === "posted" ? "posted" : r.state === "duplicate" ? "duplicate — not posted" : "dry-run recorded (nothing created)", ...slim(r) });
  }));

  server.registerTool("hold_supplier_invoice", {
    title: "Hold a supplier invoice",
    description: "Put an intake item on hold with a reason (awaiting credit note, disputed, needs OCR, wrong supplier). It stays visible in the Finance queue and is never auto-posted.",
    inputSchema: { sha256: sha, reason: z.string().min(3).max(200) },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args, extra: Extra) => runTool(async () => { const p = principalFrom(extra.authInfo); return ok(slim(await holdIntake(args.sha256, args.reason, actorName(p)))); }));

  server.registerTool("reject_supplier_invoice", {
    title: "Reject a supplier invoice",
    description: "Mark an intake item as not to be posted (duplicate already in QuickBooks, not ours, spam). Kept for audit; the PDF stays in evidence.",
    inputSchema: { sha256: sha, reason: z.string().min(3).max(200) },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (args, extra: Extra) => runTool(async () => { const p = principalFrom(extra.authInfo); return ok(slim(await rejectIntake(args.sha256, args.reason, actorName(p)))); }));

  server.registerTool("reprocess_supplier_invoice", {
    title: "Re-code a supplier invoice",
    description: "Re-run vendor / class / account / VAT resolution for one item with fresh QuickBooks reference data, supplier profiles and CRM orders (after a profile or vendor was fixed). The cached extraction is reused; a failed extraction is retried.",
    inputSchema: { sha256: sha },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args, extra: Extra) => runTool(async () => { const p = principalFrom(extra.authInfo); return ok(slim(await reprocessIntake(args.sha256, actorName(p)))); }));

  server.registerTool("run_supplier_intake", {
    title: "Run supplier-invoice intake now",
    description: "Scan the intake mailboxes for new PDF attachments now (bypasses the intake.enabled cron guard): extracts, codes and queues each invoice; auto-posts only as the autopilot switch allows (get_intake_autopilot: manual never, assisted = suppliers on autoPost, full = every certain item) and only while QuickBooks posting is on. Budget ≤ 25 PDFs / 150 mail calls per run.",
    inputSchema: { mailbox: z.string().email().optional().describe("Only this mailbox"), limit: z.number().int().min(1).max(100).optional().describe("Max PDFs this run (default 25)"), since: z.string().optional().describe("ISO date-time to scan from (ignores the saved watermark)"), dryRun: z.boolean().optional().default(false).describe("Extract and code but never post or draft") },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args, extra: Extra) => runTool(async () => { const p = principalFrom(extra.authInfo); return ok(await runIntakeJob({ mailbox: args.mailbox, limit: args.limit, since: args.since, dryRun: args.dryRun, force: true, by: actorName(p) })); }));

  server.registerTool("learn_supplier_defaults", {
    title: "Learn supplier coding defaults from QuickBooks history",
    description: "For each active vendor, read the last N months of bills and fill empty supplier-profile fields: defaultAccountName (most used account, ≥ 60% of lines), one categoryHints keyword → runner-up account, and emailDomains from the vendor's email. Never overwrites a value already set. Max 120 vendors per run; call again to continue.",
    inputSchema: { months: z.number().int().min(1).max(36).optional().default(12) },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args, extra: Extra) => runTool(async () => { const p = principalFrom(extra.authInfo); return ok(await learnSupplierDefaults({ months: args.months, by: actorName(p) })); }));

  const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD (company time zone)");

  server.registerTool("get_intake_log", {
    title: "Daily supplier-invoice log (rows + totals)",
    description: "Every supplier invoice touched in intake on a day (or inclusive from/to range): received, mailbox, sender, supplier, document number, invoice / due dates, net, VAT, gross, VAT kind, category (QuickBooks account), class (customer / project), state, QuickBooks bill id and reasons; plus totals by state and by category. Defaults to today. The same data as the CSV at /api/finance/intake/log.",
    inputSchema: { date: isoDay.optional(), from: isoDay.optional(), to: isoDay.optional() },
    annotations: { readOnlyHint: true },
  }, async (args, extra: Extra) => runTool(async () => {
    principalFrom(extra.authInfo);
    const log = await buildIntakeLog({ date: args.date, from: args.from, to: args.to || args.from });
    return ok({ window: log.window, posting: log.posting, totals: log.totals, rows: log.rows, csv: `/api/finance/intake/log?${log.window.date ? `date=${log.window.date}` : `from=${args.from || ""}&to=${args.to || args.from || ""}`}` });
  }));

  server.registerTool("send_intake_log", {
    title: "Email the daily supplier-invoice log",
    description: "Build the day's supplier-invoice log and send it from the accounts mailbox with the Excel log (CSV) attached — subject \"Supplier invoices processed — <date> — n posted / m for review\". Recipients: `to`, else the accountant, else the owner. In drafts-only mode this lands in the accounts mailbox's Drafts for a human to send (intended).",
    inputSchema: { date: isoDay.optional().describe("Default: today"), to: z.array(z.string().email()).max(10).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args, extra: Extra) => runTool(async () => {
    const p = principalFrom(extra.authInfo);
    const r = await sendIntakeLog({ date: args.date, to: args.to, actor: actorName(p) });
    return ok({ ...r, defaultRecipients: intakeLogRecipients(await getConnections(), args.to) });
  }));

  server.registerTool("create_redirect_notices", {
    title: "Draft 'please use the accounts mailbox' replies",
    description: "For every supplier invoice that arrived in a redirect mailbox (mail.redirectMailboxes) since `since` (default 14 days), leave a reply DRAFT in that mailbox asking the sender to use the accounts mailbox from now on. One draft per sender per mailbox per 30 days; internal senders skipped. Never sends. dryRun lists what would be drafted. The intake run does this automatically while mail.redirectNotices is on.",
    inputSchema: { since: z.string().optional().describe("ISO date-time"), dryRun: z.boolean().optional().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args, extra: Extra) => runTool(async () => { principalFrom(extra.authInfo); return ok(await createRedirectNotices({ since: args.since, dryRun: args.dryRun })); }));

  server.registerTool("request_owner_approvals", {
    title: "Ask the owner to approve new suppliers",
    description: "Posts every proposed invoice whose supplier does not exist in QuickBooks as an APPROVAL NEEDED list to the briefs channel (mirrored to Slack when a webhook is configured) and leaves an email draft from the accounts mailbox to the owner. Each item is asked once. The owner replies APPROVE <ref> / REJECT <ref>.",
    inputSchema: { dryRun: z.boolean().optional().default(false) },
    annotations: { readOnlyHint: false },
  }, async (args, extra: Extra) => runTool(async () => { const p = principalFrom(extra.authInfo); return ok(await requestOwnerApprovals({ by: actorName(p), dryRun: args.dryRun })); }));

  server.registerTool("apply_owner_replies", {
    title: "Read the owner's APPROVE / REJECT replies",
    description: "Scans the briefs channel (human authors) and the accounts mailbox (approver senders) for APPROVE <ref> / REJECT <ref> lines, records the decision on the intake item (REJECT also rejects the document). Run before posting anything that needed approval.",
    inputSchema: {},
    annotations: { readOnlyHint: false },
  }, async (_args, extra: Extra) => runTool(async () => { principalFrom(extra.authInfo); return ok(await applyOwnerReplies()); }));

  server.registerTool("get_intake_autopilot", {
    title: "Supplier-invoice autopilot switch",
    description: "The owner's autopilot setting for supplier-invoice posting: mode manual (nothing posts without a human — default), assisted (auto-post only suppliers whose profile has autoPost=true, earned by three agreeing posts or set by hand), full (auto-post every item with confidence ≥ minConfidence, a resolved class and a known vendor); plus minConfidence, requireClass, requireKnownVendor and who changed it last. QuickBooks posting stays the master switch. Read-only.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async (_args, extra: Extra) => runTool(async () => { principalFrom(extra.authInfo); return ok({ posting: await postingEnabled(), autopilot: await getAutopilot(), note: "Only the owner changes the mode (Finance ▸ Supplier invoices or set_intake_autopilot with an admin key). Agents report and propose; they never flip it." }); }));

  server.registerTool("set_intake_autopilot", {
    title: "Change the supplier-invoice autopilot switch (owner)",
    description: "Owner-only: set mode manual | assisted | full, minConfidence (0.5–1), requireClass, requireKnownVendor. Every auto-post is logged as a coding decision by \"autopilot\". Admin keys only; agents must not call this on their own initiative.",
    inputSchema: { mode: z.enum(["manual", "assisted", "full"]).optional(), minConfidence: z.number().min(0.5).max(1).optional(), requireClass: z.boolean().optional(), requireKnownVendor: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args, extra: Extra) => runTool(async () => {
    const p = principalFrom(extra.authInfo);
    if (p.role !== "admin") return fail("Forbidden: the autopilot switch needs an admin API key (the owner)");
    return ok({ posting: await postingEnabled(), autopilot: await setAutopilot(args, actorName(p)) });
  }));

  server.registerTool("list_coding_decisions", {
    title: "Coding decisions (learning-loop history)",
    description: "Every decision on a supplier invoice — post / hold / reject / reprocess / edit_posted by a human, agent or autopilot, plus promote / demote of a supplier's auto-post — with what the resolver proposed (vendor, class, accounts, VAT), what was finally used, which of those changed, and the invoice tokens (client surname, postcode, PO ref) that pointed at the final class. Newest first.",
    inputSchema: { vendor: z.string().optional().describe("Vendor name contains"), vendorId: z.string().optional().describe("QuickBooks Vendor id"), since: z.string().optional().describe("ISO date / date-time"), action: z.enum(["post", "hold", "reject", "reprocess", "edit_posted", "promote", "demote"]).optional(), limit: z.number().int().min(1).max(500).optional().default(100) },
    annotations: { readOnlyHint: true },
  }, async (args, extra: Extra) => runTool(async () => { principalFrom(extra.authInfo); const decisions = await listDecisions({ vendor: args.vendor, vendorId: args.vendorId, since: args.since, action: args.action, limit: args.limit }); return ok({ total: decisions.length, decisions }); }));

  server.registerTool("get_coding_stats", {
    title: "Coding agreement statistics",
    description: "Per vendor and overall: proposals, posted (and how many by autopilot), held, rejected, edits after posting, class / account / VAT agreement rates (final === proposed), average confidence, the last 10 decisions, the current autopilot setting and how many suppliers are on auto-post. Use it for the weekly learning-loop review and to propose promotions.",
    inputSchema: { since: z.string().optional().describe("ISO date / date-time; default all history") },
    annotations: { readOnlyHint: true },
  }, async (args, extra: Extra) => runTool(async () => { principalFrom(extra.authInfo); return ok(await decisionStats({ since: args.since })); }));

  server.registerTool("edit_posted_invoice", {
    title: "Modify a posted bill in QuickBooks",
    description: "Change class / account / VAT code per line, due date, document number or memo on a Bill that intake posted. Full-object update in QuickBooks (gated by the posting switch — otherwise the payload is recorded as a dry run), the intake record follows, and the edit is logged as an edit_posted decision that feeds the learning loop (a class change teaches a class hint; it also demotes the supplier from auto-post).",
    inputSchema: {
      sha256: sha,
      lines: z.array(z.object({ index: z.number().int().min(0), accountId: z.string().nullable().optional(), classId: z.string().nullable().optional().describe("null removes the class"), taxCodeId: z.string().nullable().optional() })).optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      docNumber: z.string().max(21).optional(),
      privateNote: z.string().max(4000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args, extra: Extra) => runTool(async () => {
    const p = principalFrom(extra.authInfo);
    const r = await editPostedIntake(args.sha256, { lines: args.lines, dueDate: args.dueDate, docNumber: args.docNumber, privateNote: args.privateNote }, actorName(p));
    const posting = await postingEnabled();
    return ok({ posting, result: posting ? "QuickBooks bill updated" : "dry-run recorded (QuickBooks not changed)", ...slim(r) });
  }));
}
