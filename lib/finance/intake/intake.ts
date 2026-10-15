// Supplier-invoice intake: the watched mailboxes → PDF → structured extraction
// → deterministic coding → QuickBooks Bill (+ attachment), with a review queue
// for everything that is not certain.
//
// Gates: cfg.intake.enabled (the cron runs at all), cfg.quickbooks.postBills
// (any QuickBooks mutation — off means every "post" is a dry run that records
// the exact payload), CONFIG#intake-autopilot (the owner's switch: manual |
// assisted | full, see learning.ts) and profile.autoPost (per supplier, earned
// by promotion or set by hand). Every decision — human, agent or autopilot —
// is logged as CODING_DECISION# and feeds the class-hint learning loop.
// Records: INTAKE#<sha256> (one per distinct PDF, arrivals appended),
// INDEX#BILL#<hash> (vendor + number dedupe), CURSOR#INTAKE#<mailbox>
// (watermark), HEALTH#INTAKE#<mailbox>, NOTICE#<mailbox>#<hash(sender)> (the
// "please use the accounts mailbox" reply draft left in a redirect mailbox,
// one per sender per 30 days — never sent by us). PDF bytes live only in the
// evidence store; mail and PDF text are untrusted data.
import { all } from "@/lib/core/store";
import { FinanceError, bytesHash, hash } from "@/lib/core/domain";
import { getConnections, type Connections } from "@/lib/core/config";
import { company, evidence, financeStore } from "@/lib/core/server";
import { domainOf, isEmail, normName } from "@/lib/core/text";
import { accountsMailbox, intakeMailboxes, mailProvider, type MailAttachment, type MailMessage, type MailProvider } from "@/lib/mail";
import { addProjectNote, listProjects, listSupplierOrders, type OrderRef } from "@/lib/crm/projects";
import { qboClient, qboRefData, taxCodeConfig, postingEnabled, createVendor, createBill, uploadAttachable, findBill, updateBill, type QboRefData, type TaxCodeConfig } from "@/lib/qbo/client";
import { findSupplierProfile, listSupplierProfiles, getSupplierProfile, upsertSupplierProfile, supplierDirectory, type SupplierProfile, type SupplierLike } from "@/lib/finance/suppliers";
import { registerCache } from "@/lib/finance/caches";
import { chooseExtractor, extractInvoice, resetExtraction, visionAvailable, visionExtract, MAX_PDF_BYTES, isPdfBytes, type ExtractedInvoice } from "./extractor";
import { resolveInvoice, isOwnDocument, supplierUnreadable, reasonText, type ResolveContext, type ResolveOverrides, type ResolveResult, type Resolution, type IntakeReason, type HistoryBill, type PoLike, type ProjectLike, type ProjectStatusLike, type GlobalClassHint } from "./resolve";
import { getAutopilot, autopilotDecision, recordDecision, listGlobalClassHints, AUTOPILOT_ACTOR, DEFAULT_AUTOPILOT, type AutopilotConfig, type DecisionAction } from "./learning";

const DEFAULT_PDF_BUDGET = 25;
const MAIL_CALL_BUDGET = 150;
const LOOKBACK_DAYS = 14;
const NOTICE_INTERVAL_MS = 30 * 86_400_000;
const NOTICE_DRAFT_BUDGET = 30;        // reply drafts per run
const SHARED_TTL_MS = 60_000;

// ------------------------------------------------------------------ types
export type IntakeState = "proposed" | "posted" | "held" | "rejected" | "duplicate" | "not_invoice";
export interface IntakeArrival { mailbox: string; messageId: string; attachmentId: string; fileName: string; receivedAt: string; from: string | null; subject: string | null; conversationId: string | null }
export interface IntakeRecord {
  sha256: string;
  state: IntakeState;
  arrivals: IntakeArrival[];
  evidence: { id: string; sha256: string; contentType: string; size: number };
  extraction: ExtractedInvoice | null;
  extractionError: string | null;
  extractionSource?: "text" | "vision" | null;   // "vision" = scanned PDF read from the page images (no verifiable quotes)
  resolution: Resolution | null;
  reasons: string[];
  confidence: number;
  qbo: { billId: string | null; attachableId: string | null; postedAt: string | null; dryRun: unknown | null; lastEditedAt?: string | null; lastEditDryRun?: unknown | null };
  decidedBy: string | null;
  decidedAt: string | null;
  ownerApproval?: OwnerApproval | null;     // new-supplier approvals raised to the owner (see approvals.ts)
  createdAt: string;
  updatedAt: string;
}
export interface OwnerApproval { status: "requested" | "approved" | "rejected"; ref: string; requestedAt: string; channelMessageId: string | null; decision: "approve" | "reject" | null; decidedBy: string | null; decidedAt: string | null; source: "briefs" | "email" | "ui" | null }
export interface IntakeMailbox { address: string; folder: string; enabled: boolean }
export interface IntakeRunSummary {
  skipped?: string;
  startedAt: string; ms: number; dryRun: boolean; posting: boolean;
  mailboxes: { mailbox: string; ok: boolean; error?: string; messages: number; pdfs: number; watermark: string | null }[];
  scanned: number; pdfs: number; mailCalls: number;
  created: number; arrivals: number; proposed: number; posted: number; held: number; duplicate: number; notInvoice: number;
  redirectDrafts: number;              // reply drafts left in the redirect mailboxes asking for the accounts mailbox next time
  items: { sha256: string; state: IntakeState; vendor: string | null; docNumber: string | null; gross: number | null; reasons: string[]; fileName: string }[];
  errors: string[];
}

const key = {
  intake: (sha: string) => `INTAKE#${sha}`,
  index: (vendorId: string, doc: string) => `INDEX#BILL#${hash(`${vendorId}|${normName(doc).replace(/\s+/g, "")}`)}`,
  cursor: (mb: string) => `CURSOR#INTAKE#${mb.toLowerCase()}`,
  health: (mb: string) => `HEALTH#INTAKE#${mb.toLowerCase()}`,
  notice: (mb: string, sender: string) => `NOTICE#${mb.toLowerCase()}#${hash(sender.toLowerCase())}`,
};
const now = () => new Date().toISOString();

// ------------------------------------------------------------- mailboxes
export async function listIntakeMailboxes(cfg?: Connections): Promise<IntakeMailbox[]> {
  const c = cfg ?? (await getConnections());
  return intakeMailboxes(c).map((address) => ({ address, folder: "inbox", enabled: true }));
}
export const redirectMailboxes = (cfg: Connections) => cfg.mail.redirectMailboxes.map((m) => m.toLowerCase());
export const redirectNoticesEnabled = (cfg: Connections) => !!cfg.mail.redirectNotices && redirectMailboxes(cfg).length > 0;

// ---------------------------------------------------------------- budget
// A run may make at most this many mail-provider calls so a flood of mail can
// never exhaust a serverless invocation; what is left is picked up next run.
export class CallBudget {
  calls = 0;
  constructor(readonly max: number) {}
  get exhausted() { return this.calls >= this.max; }
  take(n = 1) { if (this.calls + n > this.max) throw new FinanceError("MAIL_BUDGET_EXHAUSTED", true, 429); this.calls += n; }
}

const isPdfAttachment = (a: MailAttachment) => {
  const ct = (a.contentType || "").toLowerCase(); const name = (a.name || "").toLowerCase();
  if (a.isInline) return false;
  if (ct.startsWith("image/")) return false;
  return ct === "application/pdf" || ct === "application/x-pdf" || ((ct === "application/octet-stream" || ct === "") && name.endsWith(".pdf"));
};

// ------------------------------------------------------------ run the job
export async function runIntakeJob(opts: { limit?: number; mailbox?: string; dryRun?: boolean; since?: string; force?: boolean; by?: string } = {}): Promise<IntakeRunSummary> {
  const startedAt = now(); const t0 = Date.now();
  const cfg = await getConnections();
  const posting = await postingEnabled();
  const summary: IntakeRunSummary = { startedAt, ms: 0, dryRun: !!opts.dryRun || !posting, posting, mailboxes: [], scanned: 0, pdfs: 0, mailCalls: 0, created: 0, arrivals: 0, proposed: 0, posted: 0, held: 0, duplicate: 0, notInvoice: 0, redirectDrafts: 0, items: [], errors: [] };
  if (!cfg.intake.enabled && !opts.force) return { ...summary, skipped: "intake is switched off (intake.enabled)" };

  const provider = await mailProvider(cfg);
  const store = financeStore(); const c = company();
  const budget = new CallBudget(MAIL_CALL_BUDGET);
  const pdfBudget = Math.max(1, Math.min(opts.limit ?? DEFAULT_PDF_BUDGET, 100));
  const mailboxes = (await listIntakeMailboxes(cfg)).filter((m) => m.enabled && (!opts.mailbox || m.address === opts.mailbox.toLowerCase()));
  if (!mailboxes.length) return { ...summary, skipped: opts.mailbox ? `${opts.mailbox} is not an intake mailbox` : "no intake mailbox configured" };
  const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
  if (opts.since && Number.isNaN(sinceMs)) throw new FinanceError("SINCE_INVALID", false, 422);
  const since = opts.since ? new Date(sinceMs).toISOString() : null;
  const sharedCtx = () => loadSharedContext();
  const redirectCandidates: { arrival: IntakeArrival; record: IntakeRecord }[] = [];
  const redirectBoxes = redirectMailboxes(cfg);

  for (const mb of mailboxes) {
    const mbSummary: IntakeRunSummary["mailboxes"][number] = { mailbox: mb.address, ok: true, messages: 0, pdfs: 0, watermark: null };
    summary.mailboxes.push(mbSummary);
    if (summary.pdfs >= pdfBudget || budget.exhausted) { mbSummary.ok = false; mbSummary.error = "budget exhausted before this mailbox"; continue; }

    const probe = await provider.probe(mb.address);
    const healthRow = await store.get(c, key.health(mb.address));
    if (!probe.ok) {
      mbSummary.ok = false; mbSummary.error = probe.error || "unreachable";
      await store.transact(c, [{ key: key.health(mb.address), expected: healthRow?.version ?? null, data: { ok: false, error: probe.error || "unreachable", checkedAt: now() } }]).catch(() => {});
      continue;
    }
    await store.transact(c, [{ key: key.health(mb.address), expected: healthRow?.version ?? null, data: { ok: true, error: null, checkedAt: now() } }]).catch(() => {});

    // Watermark: the receivedAt of the last fully processed message plus the ids
    // seen at that exact instant (the provider filter is "received >= watermark").
    const cursorRow = await store.get<{ receivedDateTime: string; seenIds: string[] }>(c, key.cursor(mb.address));
    let watermark = since || cursorRow?.data?.receivedDateTime || new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
    let seen = new Set<string>(since ? [] : cursorRow?.data?.seenIds || []);
    let cursorVersion = cursorRow?.version ?? null;
    const saveCursor = async (receivedDateTime: string, ids: string[]) => {
      const data = { receivedDateTime, seenIds: ids.slice(-200), updatedAt: now() };
      await store.transact(c, [{ key: key.cursor(mb.address), expected: cursorVersion, data }]);
      cursorVersion = (cursorVersion ?? 0) + 1;
      watermark = receivedDateTime; seen = new Set(data.seenIds); mbSummary.watermark = receivedDateTime;
    };

    const top = Math.min(50, Math.max(10, pdfBudget));
    try {
      for (;;) {
        if (budget.exhausted || summary.pdfs >= pdfBudget) break;
        budget.take(1);
        const page = await provider.listMessages(mb.address, { folder: mb.folder, since: watermark, top });
        budget.calls += Math.max(0, page.calls - 1);
        // IMAP "since" is day-granular: drop anything older than the watermark instant as well as ids already done.
        const messages = page.messages.filter((m) => !seen.has(m.id) && m.receivedAt >= watermark);
        if (!messages.length) break;
        mbSummary.messages += messages.length; summary.scanned += messages.length;
        let lastDone: MailMessage | null = null;
        const doneIds: string[] = page.messages.filter((m) => seen.has(m.id)).map((m) => m.id);
        let stoppedEarly = false;
        for (const m of messages) {
          if (!m.hasAttachments) { lastDone = m; doneIds.push(m.id); continue; }
          if (summary.pdfs >= pdfBudget || budget.calls + 2 > budget.max) { stoppedEarly = true; break; }
          try {
            budget.take(1);
            const atts = await provider.listAttachments(mb.address, m.id);
            for (const a of atts.filter(isPdfAttachment)) {
              if (summary.pdfs >= pdfBudget || budget.exhausted) { stoppedEarly = true; break; }
              if ((a.size || 0) > MAX_PDF_BYTES) { summary.errors.push(`${mb.address}/${m.id}/${a.name}: over 10 MB, skipped`); continue; }
              budget.take(1);
              const bytes = await provider.getAttachment(mb.address, m.id, a.id);
              if (bytes.length > MAX_PDF_BYTES) { summary.errors.push(`${mb.address}/${m.id}/${a.name}: over 10 MB, skipped`); continue; }
              summary.pdfs += 1; mbSummary.pdfs += 1;
              const arrival: IntakeArrival = { mailbox: mb.address, messageId: m.id, attachmentId: a.id, fileName: a.name || "attachment.pdf", receivedAt: m.receivedAt, from: m.from?.address || null, subject: (m.subject || "").slice(0, 200) || null, conversationId: m.conversationId || null };
              const out = await ingestPdf(bytes, arrival, { dryRun: opts.dryRun, by: opts.by || "intake-job", shared: sharedCtx });
              if (out.created) summary.created += 1; else summary.arrivals += 1;
              if (redirectBoxes.includes(mb.address)) redirectCandidates.push({ arrival, record: out.record });
              if (out.created) {
                summary[out.record.state === "not_invoice" ? "notInvoice" : out.record.state === "posted" ? "posted" : out.record.state === "held" ? "held" : out.record.state === "duplicate" ? "duplicate" : "proposed"] += 1;
                summary.items.push({ sha256: out.record.sha256, state: out.record.state, vendor: out.record.resolution?.vendorName ?? out.record.extraction?.supplierIdentity ?? null, docNumber: out.record.resolution?.docNumber || null, gross: out.record.resolution?.totals.gross ?? null, reasons: out.record.reasons, fileName: arrival.fileName });
              }
            }
            if (stoppedEarly) break;
            lastDone = m; doneIds.push(m.id);
          } catch (e) {
            summary.errors.push(`${mb.address}/${m.id}: ${e instanceof Error ? e.message : String(e)}`);
            if (e instanceof FinanceError && e.code === "MAIL_BUDGET_EXHAUSTED") { stoppedEarly = true; break; }
            lastDone = m; doneIds.push(m.id); // a broken message must not block the mailbox forever
          }
        }
        // Advance the watermark only over messages that were fully processed.
        if (lastDone) {
          const ts = lastDone.receivedAt;
          const sameTs = doneIds.filter((id) => page.messages.find((m) => m.id === id)?.receivedAt === ts);
          await saveCursor(ts, [...[...seen].filter((id) => page.messages.find((m) => m.id === id)?.receivedAt === ts), ...sameTs]);
        }
        if (stoppedEarly || page.messages.length < top) break;
      }
    } catch (e) {
      mbSummary.ok = false; mbSummary.error = e instanceof Error ? e.message : String(e);
      summary.errors.push(`${mb.address}: ${mbSummary.error}`);
    }
  }
  summary.mailCalls = budget.calls;

  // Redirect notices: a reply draft in each redirect mailbox for every external
  // sender seen this run (one per sender per 30 days). Explicit dryRun creates nothing.
  if (redirectCandidates.length && redirectNoticesEnabled(cfg)) {
    try {
      const n = await noticesFor(redirectCandidates, cfg, provider, { dryRun: opts.dryRun });
      summary.redirectDrafts = n.created; summary.mailCalls += n.mailCalls;
      summary.errors.push(...n.errors);
    } catch (e) { summary.errors.push(`redirect notices: ${e instanceof Error ? e.message : String(e)}`); }
  }
  summary.ms = Date.now() - t0;
  return summary;
}

// ------------------------------------------------------- redirect notices
// Every invoice that lands in a redirect mailbox (say info@) gets a reply DRAFT
// telling the sender to use the accounts mailbox from now on. Threaded on the
// original message by the mail provider; never sent by us.
export interface RedirectNotice { sender: string; mailbox: string; draftId: string | null; messageId: string; createdAt: string }
export interface RedirectNoticeResult {
  enabled: boolean; dryRun: boolean;
  considered: number; created: number;
  skipped: { internal: number; recent: number; noSender: number; notNoticeWorthy: number };
  notices: RedirectNotice[];
  errors: string[];
  mailCalls: number;
}

// Internal = our own domains, any intake mailbox, tenant / no-reply addresses,
// or an address / domain on the mail block list (scanners, rules).
export function isInternalSender(email: string, cfg: Connections, mailboxes: string[]): boolean {
  const e = email.toLowerCase(); const d = domainOf(e) || "";
  if (cfg.company.internalDomains.map((x) => x.toLowerCase()).includes(d) || d.endsWith(".onmicrosoft.com")) return true;
  if (mailboxes.map((m) => m.toLowerCase()).includes(e)) return true;
  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce)[@.+-]/.test(e)) return true;
  return cfg.mail.blockEmails.map((s) => s.toLowerCase()).some((s) => s === e || s === d || (s.startsWith("@") && s.slice(1) === d));
}

// Brochures / marketing PDFs ("other") and rejected records do not earn a notice.
const noticeWorthy = (r: IntakeRecord) => r.state !== "rejected" && r.extraction?.documentType !== "other";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
export function redirectNoticeHtml(accounts: string, companyName: string, ordersMailbox?: string | null): string {
  const P = (s: string) => `<p style="margin:0 0 12px 0">${s}</p>`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:640px">${[
    P("Thank you for your document."),
    P(`From now on, please send invoices and statements to <a href="mailto:${escapeHtml(accounts)}">${escapeHtml(accounts)}</a>.`),
    ordersMailbox && ordersMailbox !== accounts ? P(`Please send order acknowledgements and order confirmations to <a href="mailto:${escapeHtml(ordersMailbox)}">${escapeHtml(ordersMailbox)}</a>.`) : "",
    P("This mailbox is not monitored for them, so using the right address means they are processed without delay."),
    P(`Kind regards,<br>${escapeHtml(companyName || "Accounts")}${companyName ? " Accounts" : ""}`),
  ].join("")}</div>`;
}

async function noticesFor(candidates: { arrival: IntakeArrival; record: IntakeRecord }[], cfg: Connections, provider: MailProvider, opts: { dryRun?: boolean } = {}): Promise<RedirectNoticeResult> {
  const result: RedirectNoticeResult = { enabled: redirectNoticesEnabled(cfg), dryRun: !!opts.dryRun, considered: 0, created: 0, skipped: { internal: 0, recent: 0, noSender: 0, notNoticeWorthy: 0 }, notices: [], errors: [], mailCalls: 0 };
  const accounts = accountsMailbox(cfg);
  if (!accounts) { result.errors.push("no accounts mailbox configured"); return result; }
  const store = financeStore(); const c = company();
  const mailboxes = intakeMailboxes(cfg);
  const boxes = redirectMailboxes(cfg);
  const budget = new CallBudget(NOTICE_DRAFT_BUDGET);
  // One draft per (mailbox, sender): reply to the newest qualifying message.
  const groups = new Map<string, { arrival: IntakeArrival; record: IntakeRecord }>();
  for (const cand of candidates) {
    const mb = cand.arrival.mailbox.toLowerCase();
    if (!boxes.includes(mb)) continue;
    result.considered += 1;
    if (!noticeWorthy(cand.record)) { result.skipped.notNoticeWorthy += 1; continue; }
    const sender = (cand.arrival.from || "").trim().toLowerCase();
    if (!sender || !isEmail(sender)) { result.skipped.noSender += 1; continue; }
    if (isInternalSender(sender, cfg, mailboxes)) { result.skipped.internal += 1; continue; }
    const k = `${mb}|${sender}`;
    const prev = groups.get(k);
    if (!prev || prev.arrival.receivedAt < cand.arrival.receivedAt) groups.set(k, cand);
  }
  const html = redirectNoticeHtml(accounts, cfg.company.name, cfg.mail.ordersMailboxes[0] || null);
  for (const [k, { arrival }] of groups) {
    const [mb, sender] = k.split("|");
    try {
      const row = await store.get<RedirectNotice>(c, key.notice(mb, sender));
      if (row?.data?.createdAt && Date.now() - Date.parse(row.data.createdAt) < NOTICE_INTERVAL_MS) { result.skipped.recent += 1; continue; }
      if (opts.dryRun) {
        result.notices.push({ sender, mailbox: mb, draftId: null, messageId: arrival.messageId, createdAt: now() });
        result.created += 1; continue;
      }
      if (budget.exhausted) { result.errors.push(`${mb}/${sender}: notice budget exhausted, will retry next run`); continue; }
      budget.take(1);
      const draft = await provider.createDraft(mb, { to: [sender], subject: `Re: ${arrival.subject || "your document"}`, html, replyToMessageId: arrival.messageId });
      const notice: RedirectNotice = { sender, mailbox: mb, draftId: draft.id, messageId: arrival.messageId, createdAt: now() };
      await store.transact(c, [{ key: key.notice(mb, sender), expected: row?.version ?? null, data: notice }]);
      result.notices.push(notice); result.created += 1;
    } catch (e) {
      result.errors.push(`${mb}/${sender}: ${e instanceof Error ? e.message : String(e)}`);
      if (e instanceof FinanceError && e.code === "MAIL_BUDGET_EXHAUSTED") break;
    }
  }
  result.mailCalls = budget.calls;
  return result;
}

// Stand-alone sweep: every INTAKE# arrival in a redirect mailbox since `since`
// (default 14 days). dryRun lists what would be drafted without touching mail.
export async function createRedirectNotices(opts: { since?: string; dryRun?: boolean } = {}): Promise<RedirectNoticeResult> {
  const cfg = await getConnections();
  const sinceMs = opts.since ? Date.parse(opts.since) : Date.now() - LOOKBACK_DAYS * 86_400_000;
  if (Number.isNaN(sinceMs)) throw new FinanceError("SINCE_INVALID", false, 422);
  const empty = (error: string): RedirectNoticeResult => ({ enabled: redirectNoticesEnabled(cfg), dryRun: !!opts.dryRun, considered: 0, created: 0, skipped: { internal: 0, recent: 0, noSender: 0, notNoticeWorthy: 0 }, notices: [], errors: [error], mailCalls: 0 });
  if (!redirectNoticesEnabled(cfg) && !opts.dryRun) return empty("redirect notices are off (mail.redirectNotices) or no redirect mailbox is configured");
  const boxes = redirectMailboxes(cfg);
  const rows = await all<IntakeRecord>(financeStore(), company(), "INTAKE#");
  const candidates: { arrival: IntakeArrival; record: IntakeRecord }[] = [];
  for (const r of rows) {
    const rec = r.data;
    if (!rec || typeof rec.sha256 !== "string" || !Array.isArray(rec.arrivals)) continue;
    for (const a of rec.arrivals) if (boxes.includes((a.mailbox || "").toLowerCase()) && Date.parse(a.receivedAt) >= sinceMs) candidates.push({ arrival: a, record: rec });
  }
  if (!candidates.length) return { ...empty(""), errors: [] };
  const provider = opts.dryRun ? null : await mailProvider(cfg);
  return noticesFor(candidates, cfg, provider as MailProvider, { dryRun: opts.dryRun });
}

// ------------------------------------------------------------ shared ctx
interface SharedContext {
  cfg: Connections;
  ref: QboRefData; taxCodes: TaxCodeConfig;
  suppliers: SupplierLike[];                     // supplier directory (profiles → id, name, domains, emails)
  projects: ProjectLike[];
  orders: OrderRef[];                            // the PO pool across every project
  profiles: SupplierProfile[];
  projectStatus: Record<string, ProjectStatusLike>;   // class-hint guard: is the project still open?
  globalClassHints: GlobalClassHint[];           // CLASS_HINT# records (learning.ts)
  autopilot: AutopilotConfig;                    // CONFIG#intake-autopilot
}
let sharedCache: { at: number; value: SharedContext } | null = null;
const historyCache = new Map<string, { at: number; value: HistoryBill[] }>();
registerCache(() => { sharedCache = null; historyCache.clear(); });

const isoOrNull = (v: string | null | undefined) => (v && v !== "N/A" && !Number.isNaN(Date.parse(v)) ? v : null);

async function loadSharedContext(fresh = false): Promise<SharedContext> {
  if (!fresh && sharedCache && Date.now() - sharedCache.at < SHARED_TTL_MS) return sharedCache.value;
  const cfg = await getConnections();
  const ref = await qboRefData();
  const taxCodes = await taxCodeConfig(ref);
  const [projects, orders, profiles, globalClassHints, autopilot] = await Promise.all([
    listProjects({ includeCancelled: true }).catch(() => []),
    listSupplierOrders().catch(() => [] as OrderRef[]),
    listSupplierProfiles().catch(() => [] as SupplierProfile[]),
    listGlobalClassHints().catch(() => [] as GlobalClassHint[]),
    getAutopilot().catch(() => ({ ...DEFAULT_AUTOPILOT })),
  ]);
  const projectStatus: Record<string, ProjectStatusLike> = {};
  for (const p of projects) {
    // Completed = final sign-off dated; closed = cancelled or lost (dated by the close / last update).
    const closedAt = p.status === "cancelled" || p.status === "lost" ? (isoOrNull(p.closedAt) || isoOrNull(p.updatedAt)) : null;
    projectStatus[p.id] = { id: p.id, status: p.status, completedAt: isoOrNull(p.signOff2At) || isoOrNull(p.completedAt) || (p.status === "completed" ? isoOrNull(p.updatedAt) : null), closedAt };
  }
  const value: SharedContext = {
    cfg, ref, taxCodes, profiles, projectStatus, globalClassHints, autopilot, orders,
    suppliers: supplierDirectory(profiles),
    projects: projects.map((p) => ({ id: p.id, name: `${p.firstName || ""} ${p.lastName || ""}`.trim(), lastName: p.lastName || "", postcode: p.postcode || null })),
  };
  sharedCache = { at: Date.now(), value };
  return value;
}

// A vendor matched through a trading name, address segment or alias: remember
// the identity as printed on the PDF on the supplier profile so the next
// invoice resolves exactly (profile → score 1). Never blocks intake.
async function learnVendorAlias(r: Resolution, identity: string, shared: SharedContext, by: string): Promise<void> {
  if (!r.vendorId || r.vendorScore < 0.8 || !["name", "alias"].includes(r.vendorSource)) return;
  const alias = (identity || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (alias.length < 3) return;
  const n = normName(alias);
  const vendorId = r.vendorId;
  const profile = shared.profiles.find((p) => p.vendorId === vendorId) || await getSupplierProfile(vendorId).catch(() => null);
  const known = [profile?.vendorName, r.vendorName, ...(profile?.aliases || [])].filter((x): x is string => !!x).map(normName);
  if (!n || known.includes(n)) return;
  const saved = await upsertSupplierProfile(vendorId, { vendorName: profile?.vendorName || r.vendorName || vendorId, aliases: [...(profile?.aliases || []), alias] }, by).catch(() => null);
  if (saved) { shared.profiles = [...shared.profiles.filter((p) => p.vendorId !== vendorId), saved]; shared.suppliers = supplierDirectory(shared.profiles); }
}

const toPo = (o: OrderRef): PoLike => ({ id: o.id, reference: o.reference, projectId: o.projectId, projectName: o.projectName, orderType: o.orderType || "contract", supplierName: o.supplierName });

// Purchase orders for the supplier on this invoice: found through the sender
// domain or name in the supplier directory, else by the name on the orders.
function ordersForSupplier(vendorName: string, senderDomain: string | null, shared: SharedContext): PoLike[] {
  const n = normName(vendorName);
  const crm = shared.suppliers.find((s) => senderDomain && s.domains.includes(senderDomain))
    || (n ? shared.suppliers.find((s) => s.norm === n) : undefined)
    || (n.length > 3 ? shared.suppliers.find((s) => s.norm.length > 3 && (s.norm.includes(n) || n.includes(s.norm))) : undefined);
  return shared.orders
    .filter((o) => (crm && (o.supplierId === crm.id || normName(o.supplierName) === crm.norm)) || (!!n && normName(o.supplierName) === n))
    .map(toPo);
}

async function buildContext(x: ExtractedInvoice, arrival: IntakeArrival, shared: SharedContext, overrides?: ResolveOverrides): Promise<ResolveContext> {
  const senderDomain = domainOf(arrival.from);
  const profile = await findSupplierProfile({ vendorId: overrides?.vendorId || null, email: arrival.from, emailDomain: senderDomain, name: x.supplierIdentity }).catch(() => null);
  // CRM supplier → purchase orders (reference / project name drive the class).
  const orders = ordersForSupplier(profile?.vendorName || x.supplierIdentity, senderDomain, shared);
  // Vendor history (last 20 bills) for class/account agreement.
  let vendorHistory: HistoryBill[] = [];
  const vendorId = overrides?.vendorId || (profile && shared.ref.vendors.some((v) => v.id === profile.vendorId) ? profile.vendorId : null) || shared.ref.vendors.find((v) => v.name.trim().toLowerCase() === (x.supplierIdentity || "").trim().toLowerCase())?.id || null;
  if (vendorId) vendorHistory = await vendorBillHistory(vendorId).catch(() => []);
  return { ref: shared.ref, taxCodes: shared.taxCodes, profile, senderDomain, senderEmail: arrival.from, orders, projects: shared.projects, vendorHistory, receivedAt: arrival.receivedAt, overrides, profiles: shared.profiles, globalClassHints: shared.globalClassHints, projectStatus: shared.projectStatus, internalDomains: shared.cfg.company.internalDomains };
}

export async function vendorBillHistory(vendorId: string, max = 20): Promise<HistoryBill[]> {
  const cached = historyCache.get(vendorId);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
  const api = await qboClient();
  const q = `select * from Bill where VendorRef = '${vendorId.replace(/'/g, "\\'")}' orderby TxnDate desc maxresults ${max}`;
  const r = await api.call(`/query?query=${encodeURIComponent(q)}`);
  const out: HistoryBill[] = [];
  for (const b of r.QueryResponse?.Bill ?? []) for (const l of b.Line ?? []) {
    const d = l.AccountBasedExpenseLineDetail; if (!d) continue;
    out.push({ classId: d.ClassRef?.value ? String(d.ClassRef.value) : null, className: d.ClassRef?.name || null, accountId: d.AccountRef?.value ? String(d.AccountRef.value) : null, accountName: d.AccountRef?.name || null });
  }
  historyCache.set(vendorId, { at: Date.now(), value: out });
  return out;
}

// ------------------------------------------------------------- ingest one
async function ingestPdf(bytes: Uint8Array, arrival: IntakeArrival, opts: { dryRun?: boolean; by: string; shared: () => Promise<SharedContext> }): Promise<{ created: boolean; record: IntakeRecord }> {
  const store = financeStore(); const c = company();
  const sha256 = bytesHash(bytes);
  const existing = await store.get<IntakeRecord>(c, key.intake(sha256));
  if (existing) {
    // Same PDF again (second mailbox / forward): remember where it arrived, nothing else.
    const dup = existing.data.arrivals.some((a) => a.messageId === arrival.messageId && a.attachmentId === arrival.attachmentId);
    if (dup) return { created: false, record: existing.data };
    const next: IntakeRecord = { ...existing.data, arrivals: [...existing.data.arrivals, arrival].slice(-20), updatedAt: now() };
    await store.transact(c, [{ key: key.intake(sha256), expected: existing.version, data: next }]);
    return { created: false, record: next };
  }
  const put = await evidence().put(c, bytes, "application/pdf");
  const base: IntakeRecord = {
    sha256, state: "held", arrivals: [arrival], evidence: { id: put.id, sha256: put.sha256, contentType: "application/pdf", size: bytes.length },
    extraction: null, extractionError: null, extractionSource: null, resolution: null, reasons: [], confidence: 0,
    qbo: { billId: null, attachableId: null, postedAt: null, dryRun: null }, decidedBy: null, decidedAt: null, createdAt: now(), updatedAt: now(),
  };
  const record = await classifyAndResolve(base, bytes, await opts.shared(), { dryRun: opts.dryRun, by: opts.by });
  await store.transact(c, [{ key: key.intake(sha256), expected: null, data: record }]);
  if (record.state === "proposed" && record.resolution?.vendorId && record.resolution.docNumber) await writeIndex(record.resolution.vendorId, record.resolution.docNumber, sha256).catch(() => {});
  // Autopilot: the owner's switch (manual | assisted | full) decides whether a
  // certain, classed, known-vendor item posts without a human. The posting
  // switch remains the master; every auto-post is logged as a decision by "autopilot".
  if (record.state === "proposed" && !opts.dryRun) {
    const shared = await opts.shared();
    const verdict = await autopilotVerdict(record, shared);
    if (verdict.post) {
      try { const posted = await postIntake(sha256, { by: AUTOPILOT_ACTOR, overrides: verdict.overrides }); return { created: true, record: posted }; }
      catch (e) {
        const r = await store.get<IntakeRecord>(c, key.intake(sha256));
        const held = r ? await updateRecord(sha256, (x) => ({ ...x, reasons: [`AUTOPILOT_FAILED:${e instanceof Error ? e.message.slice(0, 160) : "unknown"}`, ...x.reasons.filter((k) => !k.startsWith("AUTOPILOT_FAILED"))] })).catch(() => r.data) : null;
        if (held) return { created: true, record: held };
      }
    }
  }
  return { created: true, record };
}

// What the autopilot would do with a proposed item right now (also exposed to
// the UI / tools so the owner can see why something waited).
export async function autopilotVerdict(record: IntakeRecord, shared?: Pick<SharedContext, "autopilot" | "profiles">) {
  const cfg = shared?.autopilot || await getAutopilot();
  const vendorId = record.resolution?.vendorId || null;
  const profile = vendorId ? (shared?.profiles.find((p) => p.vendorId === vendorId) || await getSupplierProfile(vendorId).catch(() => null)) : null;
  return autopilotDecision(cfg, {
    state: record.state, confidence: record.confidence, reasons: record.reasons, vendorId, vendorScore: record.resolution?.vendorScore,
    classId: record.resolution?.classId || null, ownerApproved: record.ownerApproval?.decision === "approve",
    profile: profile ? { autoPost: profile.autoPost, onHold: profile.onHold } : null,
  }, await postingEnabled());
}

// Decisions are history, never a reason for an action to fail.
async function logDecision(input: { record: IntakeRecord; action: DecisionAction; by: string; proposed: Resolution | null; final: Resolution | null; dryRun?: boolean; note?: string | null; ctx?: { projects?: ProjectLike[]; orders?: PoLike[]; autopilot?: AutopilotConfig } }) {
  try { await recordDecision(input); }
  catch (e) { console.error("intake decision log failed:", e instanceof Error ? e.message : e); }
}

// Trim what we keep in the store: the extraction without long free text.
function slimExtraction(x: ExtractedInvoice): ExtractedInvoice {
  const clip = (s: string | null, n: number) => (s == null ? s : s.slice(0, n));
  return {
    ...x,
    supplierIdentity: x.supplierIdentity.slice(0, 120), documentNumber: x.documentNumber.slice(0, 60), invoiceDateText: x.invoiceDateText.slice(0, 60),
    dateEvidenceQuote: clip(x.dateEvidenceQuote, 120), projectReference: clip(x.projectReference, 120), poReference: clip(x.poReference, 120),
    lines: x.lines.slice(0, 60).map((l) => ({ ...l, description: l.description.slice(0, 200), sku: clip(l.sku, 40), itemFamily: l.itemFamily.slice(0, 40), useContext: l.useContext.slice(0, 60), vatEvidenceQuote: clip(l.vatEvidenceQuote, 120) })),
  };
}

async function classifyAndResolve(rec: IntakeRecord, bytes: Uint8Array, shared: SharedContext, opts: { dryRun?: boolean; by: string; overrides?: ResolveOverrides }): Promise<IntakeRecord> {
  const cfg = shared.cfg;
  const arrival = rec.arrivals[rec.arrivals.length - 1];
  if (!chooseExtractor(cfg)) return { ...rec, state: "held", extraction: null, extractionError: "MODEL_NOT_CONFIGURED", reasons: ["MODEL_NOT_CONFIGURED"], confidence: 0, updatedAt: now() };
  let x: ExtractedInvoice;
  let extractionSource: NonNullable<IntakeRecord["extractionSource"]> = "text";
  try {
    x = await extractInvoice(rec.sha256, bytes, "application/pdf", cfg);
  } catch (e) {
    const code = e instanceof FinanceError ? e.code : e instanceof Error ? e.message.slice(0, 200) : "EXTRACTION_FAILED";
    // Scanned / image-only PDF: no text layer. Let the model read the pages
    // visually; the record stays held only when that also fails.
    if (code === "DOCUMENT_OCR_REQUIRED" && visionAvailable(cfg) && isPdfBytes(bytes)) {
      try { x = await visionExtract(bytes, rec.sha256, cfg); extractionSource = "vision"; }
      catch (ve) {
        const vcode = ve instanceof FinanceError ? ve.code : ve instanceof Error ? ve.message.slice(0, 160) : "VISION_FAILED";
        return { ...rec, state: "held", extraction: null, extractionError: `DOCUMENT_OCR_REQUIRED (vision: ${vcode})`, extractionSource: null, reasons: ["DOCUMENT_OCR_REQUIRED"], confidence: 0, updatedAt: now() };
      }
    } else {
      const reason: IntakeReason | string = code === "CORRUPT_DOCUMENT" ? "DOCUMENT_OCR_REQUIRED" : code;
      return { ...rec, state: "held", extraction: null, extractionError: code, extractionSource: null, reasons: [reason], confidence: 0, updatedAt: now() };
    }
  }
  const slim = slimExtraction(x);
  // Our own sales invoices / quotes forwarded internally are never bills.
  if (isOwnDocument(x, { name: cfg.company.name, vatNumber: cfg.company.vatNumber })) {
    return { ...rec, state: "not_invoice", extraction: slim, extractionError: null, extractionSource, reasons: ["own_document"], confidence: 0, updatedAt: now() };
  }
  if (x.documentType !== "invoice") {
    return { ...rec, state: "not_invoice", extraction: slim, extractionError: null, extractionSource, reasons: [x.documentType], confidence: 0, updatedAt: now() };
  }
  // A PDF an internal address sent out, on which no supplier can be read, is
  // almost always one of our own sales invoices (the extractor never names us
  // as the supplier). Hold it for a person instead of asking the owner to
  // approve a new supplier called "unknown".
  if (arrival.from && isInternalSender(arrival.from, cfg, [arrival.mailbox]) && supplierUnreadable(x)) {
    return { ...rec, state: "held", extraction: slim, extractionError: null, extractionSource, reasons: ["OWN_DOCUMENT_SUSPECTED"], confidence: 0, updatedAt: now() };
  }
  const ctx = await buildContext(x, arrival, shared, opts.overrides);
  const r: ResolveResult = resolveInvoice(x, ctx);
  await learnVendorAlias(r.resolution, x.supplierIdentity, shared, opts.by).catch(() => {});
  let state: IntakeState = "proposed";
  const reasons: string[] = r.reasons.map((k) => reasonText(k, x));
  // Dedupe by vendor + document number (our index, then QuickBooks itself).
  if (r.resolution.vendorId && r.resolution.docNumber) {
    const idx = await financeStore().get<{ sha256: string; billId?: string | null }>(company(), key.index(r.resolution.vendorId, r.resolution.docNumber));
    if (idx && idx.data.sha256 !== rec.sha256) { state = "duplicate"; reasons.unshift(`DUPLICATE_OF:${idx.data.sha256}${idx.data.billId ? ` (QuickBooks bill ${idx.data.billId})` : ""}`); }
    else {
      try { const bill = await findBill(r.resolution.vendorId, r.resolution.docNumber); if (bill) { state = "duplicate"; reasons.unshift(`QBO_BILL_EXISTS:${bill.Id} dated ${bill.TxnDate} for ${bill.TotalAmt}`); } }
      catch (e) { reasons.push(`DUPLICATE_CHECK_FAILED:${e instanceof Error ? e.message.slice(0, 80) : "unknown"}`); }
    }
  }
  return { ...rec, state, extraction: slim, extractionError: null, extractionSource, resolution: r.resolution, reasons, confidence: state === "duplicate" ? 0 : r.confidence, updatedAt: now() };
}

async function writeIndex(vendorId: string, docNumber: string, sha256: string, billId: string | null = null) {
  const store = financeStore(); const c = company();
  const k = key.index(vendorId, docNumber);
  const row = await store.get<{ sha256: string; billId: string | null }>(c, k);
  if (row && row.data.sha256 !== sha256) return; // first one wins; the later sha is marked duplicate
  await store.transact(c, [{ key: k, expected: row?.version ?? null, data: { sha256, vendorId, docNumber, billId: billId ?? row?.data.billId ?? null, updatedAt: now() } }]);
}

// ------------------------------------------------------------------ reads
export async function getIntake(sha256: string): Promise<IntakeRecord | null> {
  const row = await financeStore().get<IntakeRecord>(company(), key.intake(sha256));
  return row?.data?.sha256 ? row.data : null;
}

export async function listIntake(filter: { state?: IntakeState | "all" | "open"; vendor?: string; limit?: number } = {}): Promise<IntakeRecord[]> {
  const rows = await all<IntakeRecord>(financeStore(), company(), "INTAKE#");
  const state = filter.state || "open";
  const vendor = (filter.vendor || "").toLowerCase();
  return rows.map((r) => r.data).filter((d) => d && typeof d.sha256 === "string" && Array.isArray(d.arrivals))
    .filter((d) => state === "all" ? true : state === "open" ? ["proposed", "held"].includes(d.state) : d.state === state)
    .filter((d) => !vendor || (d.resolution?.vendorName || d.extraction?.supplierIdentity || "").toLowerCase().includes(vendor))
    .sort((a, b) => (b.arrivals[0]?.receivedAt || b.createdAt).localeCompare(a.arrivals[0]?.receivedAt || a.createdAt))
    .slice(0, Math.max(1, Math.min(filter.limit ?? 100, 500)));
}

export async function readIntakePdf(sha256: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  const rec = await getIntake(sha256);
  if (!rec) return null;
  const bytes = await evidence().read(company(), rec.evidence.id);
  return { bytes, fileName: rec.arrivals[0]?.fileName || `${sha256.slice(0, 12)}.pdf` };
}

// Mailbox health and watermarks for the queue header.
export async function intakeMailboxHealth(cfg?: Connections) {
  const store = financeStore(); const c = company();
  const mailboxes = await listIntakeMailboxes(cfg);
  return Promise.all(mailboxes.map(async (m) => {
    const [h, cur] = await Promise.all([store.get<{ ok: boolean; error: string | null; checkedAt: string }>(c, key.health(m.address)), store.get<{ receivedDateTime: string }>(c, key.cursor(m.address))]);
    return { mailbox: m.address, enabled: m.enabled, ok: h?.data?.ok ?? null, error: h?.data?.error ?? null, checkedAt: h?.data?.checkedAt ?? null, watermark: cur?.data?.receivedDateTime ?? null };
  }));
}

// Reference lists for the review UI's selects. fresh=true re-reads vendors /
// accounts / classes from QuickBooks right now, so a category or class
// created a minute ago shows up without waiting for the 10-minute cache.
export async function intakeOptions(fresh = false) {
  const ref = await qboRefData(fresh);
  const taxCodes = await taxCodeConfig(ref);
  return {
    vendors: ref.vendors.map((v) => ({ id: v.id, name: v.name })).sort((a, b) => a.name.localeCompare(b.name)),
    accounts: ref.accounts.map((a) => ({ id: a.id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name)),
    classes: ref.classes.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
    taxCodes: ref.taxCodes.map((t) => ({ id: t.id, name: t.name })),
    taxDefaults: { standard: taxCodes.standard, zero: taxCodes.zero, exempt: taxCodes.exempt, reverseCharge: taxCodes.reverseCharge },
  };
}

// ---------------------------------------------------------------- actions
export async function setOwnerApproval(sha256: string, approval: OwnerApproval): Promise<IntakeRecord> {
  return updateRecord(sha256, (r) => ({ ...r, ownerApproval: approval }));
}

async function updateRecord(sha256: string, patch: (r: IntakeRecord) => IntakeRecord): Promise<IntakeRecord> {
  const store = financeStore(); const c = company();
  const row = await store.get<IntakeRecord>(c, key.intake(sha256));
  if (!row?.data?.sha256) throw new FinanceError("INTAKE_NOT_FOUND", false, 404);
  const next = { ...patch(row.data), updatedAt: now() };
  await store.transact(c, [{ key: key.intake(sha256), expected: row.version, data: next }]);
  return next;
}

export async function holdIntake(sha256: string, reason: string, by: string) {
  const saved = await updateRecord(sha256, (r) => {
    if (r.state === "posted") throw new FinanceError("INTAKE_ALREADY_POSTED", false, 409);
    return { ...r, state: "held", reasons: [`HELD:${reason.slice(0, 200)}`, ...r.reasons.filter((x) => !x.startsWith("HELD:"))], decidedBy: by, decidedAt: now() };
  });
  await logDecision({ record: saved, action: "hold", by, proposed: saved.resolution, final: saved.resolution, note: reason.slice(0, 200) });
  return saved;
}

export async function rejectIntake(sha256: string, reason: string, by: string) {
  const saved = await updateRecord(sha256, (r) => {
    if (r.state === "posted") throw new FinanceError("INTAKE_ALREADY_POSTED", false, 409);
    return { ...r, state: "rejected", reasons: [`REJECTED:${reason.slice(0, 200)}`, ...r.reasons.filter((x) => !x.startsWith("REJECTED:"))], decidedBy: by, decidedAt: now() };
  });
  await logDecision({ record: saved, action: "reject", by, proposed: saved.resolution, final: saved.resolution, note: reason.slice(0, 200) });
  return saved;
}

// Re-run coding (fresh reference data, profiles, CRM orders). The extraction
// itself is cached by sha in EXTRACTION# and is not repeated.
export async function reprocessIntake(sha256: string, by = "reprocess"): Promise<IntakeRecord> {
  const rec = await getIntake(sha256);
  if (!rec) throw new FinanceError("INTAKE_NOT_FOUND", false, 404);
  if (rec.state === "posted") throw new FinanceError("INTAKE_ALREADY_POSTED", false, 409);
  const bytes = await evidence().read(company(), rec.evidence.id);
  // A failed model call leaves EXTRACTION#<sha> in state "attempted"; an explicit
  // reprocess is permission to try again, so clear it first.
  if (!rec.extraction) await resetExtraction(sha256).catch(() => false);
  const fresh = await classifyAndResolve({ ...rec, qbo: { billId: null, attachableId: null, postedAt: null, dryRun: null } }, bytes, await loadSharedContext(true), { by });
  const saved = await updateRecord(sha256, () => ({ ...fresh, decidedBy: by, decidedAt: now() }));
  if (saved.state === "proposed" && saved.resolution?.vendorId && saved.resolution.docNumber) await writeIndex(saved.resolution.vendorId, saved.resolution.docNumber, sha256).catch(() => {});
  await logDecision({ record: saved, action: "reprocess", by, proposed: rec.resolution, final: saved.resolution });
  return saved;
}

const formatMoney = (v: number, currency: string) => new Intl.NumberFormat("en-GB", { style: "currency", currency: currency || "GBP" }).format(v);
function shiftIso(iso: string, days: number) { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }

// Post (or dry-run) one intake item to QuickBooks as a Bill with the PDF attached.
export async function postIntake(sha256: string, opts: { overrides?: ResolveOverrides; by: string; dryRun?: boolean; force?: boolean }): Promise<IntakeRecord> {
  const store = financeStore(); const c = company();
  const row = await store.get<IntakeRecord>(c, key.intake(sha256));
  if (!row?.data?.sha256) throw new FinanceError("INTAKE_NOT_FOUND", false, 404);
  const rec = row.data;
  if (rec.state === "posted") throw new FinanceError("INTAKE_ALREADY_POSTED", false, 409);
  if (rec.state === "rejected" || rec.state === "not_invoice") throw new FinanceError(`INTAKE_NOT_POSTABLE: state is ${rec.state} — reprocess first`, false, 409);
  if (!rec.extraction) throw new FinanceError(`INTAKE_NOT_POSTABLE: no extraction (${rec.extractionError || "unknown"})`, false, 409);
  const dryRun = !!opts.dryRun || !(await postingEnabled());

  const shared = await loadSharedContext();
  const arrival = rec.arrivals[rec.arrivals.length - 1];
  const ctx = await buildContext(rec.extraction, arrival, shared, opts.overrides);
  let { resolution, reasons } = resolveInvoice(rec.extraction, ctx);
  let vendorCreated: unknown | null = null;

  // Vendor missing: creating a supplier in QuickBooks needs the owner's approval
  // (APPROVE <ref> in the briefs channel or by email) unless a known vendorId is supplied.
  if (!resolution.vendorId && resolution.vendorProposed && !dryRun && !opts.force && !opts.overrides?.vendorId && rec.ownerApproval?.decision !== "approve") {
    throw new FinanceError(`OWNER_APPROVAL_REQUIRED: new supplier "${resolution.vendorProposed.displayName}" — ask the owner to reply APPROVE ${sha256.slice(0, 8)} (request_owner_approvals), or post with an existing vendorId override`, false, 409);
  }
  if (!resolution.vendorId && resolution.vendorProposed) {
    const termId = ctx.profile?.terms ? shared.ref.terms.find((t) => ctx.profile!.terms!.kind === "days" ? t.dueDays === ctx.profile!.terms!.days : t.type === "DATE_DRIVEN")?.id ?? null : null;
    const made = await createVendor({ displayName: resolution.vendorProposed.displayName, email: resolution.vendorProposed.email, termId }, { dryRun });
    vendorCreated = made.dryRun ? { dryRun: true, payload: made.payload } : { id: made.entity?.Id, payload: made.payload };
    if (!made.dryRun && made.entity?.Id) {
      const ref = await qboRefData(true);
      const again = resolveInvoice(rec.extraction, { ...ctx, ref, overrides: { ...(opts.overrides || {}), vendorId: String(made.entity.Id) } });
      resolution = again.resolution; reasons = again.reasons;
    }
  }

  const blocking = reasons.filter((r) => !["TERMS_MISSING", "VENDOR_UNKNOWN"].includes(r) || (r === "VENDOR_UNKNOWN" && !vendorCreated));
  if (resolution.vendorId == null && !vendorCreated) blocking.push("VENDOR_UNKNOWN");
  if (!resolution.txnDate) blocking.push("DATE_AMBIGUOUS");
  const dueDate = resolution.dueDate || (resolution.txnDate ? shiftIso(resolution.txnDate, 30) : null);
  if (!dryRun && blocking.length) throw new FinanceError(`INTAKE_NOT_POSTABLE: ${[...new Set(blocking)].join(", ")} — fix with overrides`, false, 422);

  const bill = {
    vendorId: resolution.vendorId || "pending-vendor",
    txnDate: resolution.txnDate || arrival.receivedAt.slice(0, 10),
    dueDate: dueDate || arrival.receivedAt.slice(0, 10),
    docNumber: resolution.docNumber || `NO-NUMBER-${sha256.slice(0, 8)}`,
    privateNote: `Finance Agents intake ${sha256.slice(0, 12)} · ${arrival.mailbox} · ${arrival.fileName}${resolution.matchedPo ? ` · PO ${resolution.matchedPo.reference}` : ""} · posted by ${opts.by}`,
    lines: resolution.lines.map((l) => ({ amount: l.amount, accountId: l.accountId || "unresolved", classId: l.classId, taxCodeId: l.taxCodeId, description: l.description })),
  };

  let billId: string | null = null, attachableId: string | null = null;
  let state: IntakeState = rec.state === "duplicate" ? "duplicate" : "proposed";
  let qboDry: unknown | null = null;
  const finalReasons: string[] = [...reasons];
  try {
    const made = await createBill(bill, { dryRun });
    if (made.dryRun) {
      qboDry = { bill: made.payload, attachable: { FileName: arrival.fileName, ContentType: "application/pdf", size: rec.evidence.size }, vendor: vendorCreated, blocking: [...new Set(blocking)] };
    } else {
      billId = String(made.entity?.Id || ""); state = "posted";
      try {
        const bytes = await evidence().read(c, rec.evidence.id);
        const att = await uploadAttachable(bytes, arrival.fileName.endsWith(".pdf") ? arrival.fileName : `${arrival.fileName}.pdf`, "application/pdf", { entityType: "Bill", entityId: billId });
        attachableId = att.entity?.Id ? String(att.entity.Id) : null;
      } catch (e) { finalReasons.push(`ATTACHMENT_FAILED:${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`); }
    }
  } catch (e) {
    if (e instanceof FinanceError && e.code.startsWith("BILL_DUPLICATE")) {
      return updateRecord(sha256, (r) => ({ ...r, state: "duplicate", resolution, reasons: [e.code, ...r.reasons.filter((x) => !x.startsWith("BILL_DUPLICATE"))], decidedBy: opts.by, decidedAt: now() }));
    }
    throw e;
  }

  const saved = await updateRecord(sha256, (r) => ({
    ...r, state, resolution, reasons: finalReasons, confidence: state === "posted" ? 1 : r.confidence,
    qbo: { billId, attachableId, postedAt: state === "posted" ? now() : null, dryRun: qboDry },
    decidedBy: opts.by, decidedAt: now(),
  }));

  if (state === "posted") {
    if (resolution.vendorId && resolution.docNumber) await writeIndex(resolution.vendorId, resolution.docNumber, sha256, billId).catch(() => {});
    if (resolution.projectId) {
      addProjectNote(resolution.projectId, `Supplier bill posted: ${resolution.vendorName} ${resolution.docNumber} — ${formatMoney(resolution.totals.gross, shared.cfg.company.currency)} inc VAT · QuickBooks bill ${billId} · ${resolution.lines.map((l) => l.accountName).filter(Boolean).join(", ")} · from ${arrival.mailbox} (${arrival.fileName})`, opts.by).catch(() => {});
    }
  }
  // Learning loop: what the resolver proposed (the record as it stood) vs what
  // was posted; feeds class hints, agreement stats and auto-post promotion.
  if (state === "posted" || dryRun) {
    await logDecision({ record: saved, action: "post", by: opts.by, proposed: rec.resolution, final: resolution, dryRun, ctx: { projects: shared.projects, orders: ctx.orders, autopilot: shared.autopilot } });
  }
  return saved;
}

// ------------------------------------------------- modify a posted bill
// Change class / account / VAT per line, due date, document number or memo on a
// Bill that intake posted. Full-object update through updateBill (gated by the
// posting switch), then the record's resolution follows and the edit is logged
// as an edit_posted decision (a class change here teaches the same hints as a
// change before posting).
export interface PostedEdit {
  lines?: { index: number; accountId?: string | null; classId?: string | null; taxCodeId?: string | null }[];
  dueDate?: string | null;
  docNumber?: string | null;
  privateNote?: string | null;
}

export async function editPostedIntake(sha256: string, changes: PostedEdit, by: string): Promise<IntakeRecord> {
  const rec = await getIntake(sha256);
  if (!rec) throw new FinanceError("INTAKE_NOT_FOUND", false, 404);
  if (rec.state !== "posted" || !rec.qbo.billId || !rec.resolution) throw new FinanceError("INTAKE_NOT_POSTED: only a bill that intake posted to QuickBooks can be edited here", false, 409);
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (changes.dueDate && !iso.test(changes.dueDate)) throw new FinanceError("DUE_DATE_INVALID", false, 422);
  const lineEdits = (changes.lines || []).filter((l) => Number.isInteger(l.index) && l.index >= 0 && l.index < rec.resolution!.lines.length);
  const touches = lineEdits.length || changes.dueDate || changes.docNumber || changes.privateNote != null;
  if (!touches) throw new FinanceError("EDIT_EMPTY", false, 422);

  const ref = await qboRefData();
  const taxCodes = await taxCodeConfig(ref);
  const byId = <T extends { id: string }>(xs: T[], id: string | null | undefined) => (id ? xs.find((x) => x.id === id) || null : null);
  for (const l of lineEdits) {
    if (l.accountId && !byId(ref.accounts, l.accountId)) throw new FinanceError(`ACCOUNT_UNKNOWN:${l.accountId}`, false, 422);
    if (l.classId && !byId(ref.classes, l.classId)) throw new FinanceError(`CLASS_UNKNOWN:${l.classId}`, false, 422);
    if (l.taxCodeId && !byId(ref.taxCodes, l.taxCodeId)) throw new FinanceError(`TAX_CODE_UNKNOWN:${l.taxCodeId}`, false, 422);
  }

  const result = await updateBill(rec.qbo.billId, (bill) => {
    const expenseLines: any[] = (bill.Line || []).filter((x: any) => x.DetailType === "AccountBasedExpenseLineDetail");
    for (const l of lineEdits) {
      // Intake created lines with Id = index + 1; fall back to position among expense lines.
      const target = expenseLines.find((x) => String(x.Id) === String(l.index + 1)) || expenseLines[l.index];
      if (!target) throw new FinanceError(`BILL_LINE_MISSING:${l.index}`, false, 409);
      const d = (target.AccountBasedExpenseLineDetail ||= {});
      if (l.accountId) d.AccountRef = { value: l.accountId };
      if (l.classId !== undefined) { if (l.classId) d.ClassRef = { value: l.classId }; else delete d.ClassRef; }
      if (l.taxCodeId) d.TaxCodeRef = { value: l.taxCodeId };
    }
    if (changes.dueDate) bill.DueDate = changes.dueDate;
    if (changes.docNumber) bill.DocNumber = changes.docNumber.slice(0, 21);
    if (changes.privateNote != null) bill.PrivateNote = changes.privateNote.slice(0, 4000);
    return bill;
  });

  // Mirror the change on the record's resolution.
  const before = rec.resolution;
  const lines = before.lines.map((ln, i) => {
    const e = lineEdits.find((x) => x.index === i);
    if (!e) return ln;
    const acc = e.accountId ? byId(ref.accounts, e.accountId) : null;
    const cls = e.classId ? byId(ref.classes, e.classId) : null;
    const vatKind = e.taxCodeId ? ((Object.entries(taxCodes).find(([k, v]) => v === e.taxCodeId && k !== "names") || [null])[0] as typeof ln.vatKind) : ln.vatKind;
    return {
      ...ln,
      ...(acc ? { accountId: acc.id, accountName: acc.name, accountSource: "override" as const } : {}),
      ...(e.classId !== undefined ? { classId: e.classId || null, className: cls?.name || null } : {}),
      ...(e.taxCodeId ? { taxCodeId: e.taxCodeId, vatKind } : {}),
    };
  });
  const lineClasses = Array.from(new Set(lines.map((l) => l.classId).filter((x): x is string => !!x)));
  const headerClassId = lineClasses.length === 1 ? lineClasses[0] : lineClasses.length ? before.classId : null;
  const after: Resolution = {
    ...before, lines,
    classId: headerClassId, className: headerClassId ? (byId(ref.classes, headerClassId)?.name || before.className) : null,
    classScore: lineEdits.some((l) => l.classId !== undefined) ? 1 : before.classScore,
    dueDate: changes.dueDate || before.dueDate, termName: changes.dueDate ? "edited" : before.termName,
    docNumber: changes.docNumber || before.docNumber,
  };
  const saved = await updateRecord(sha256, (r) => ({
    ...r, resolution: after, decidedBy: by, decidedAt: now(),
    reasons: [result.dryRun ? "EDIT_DRY_RUN: QuickBooks posting is off — bill not changed" : `EDITED_IN_QBO by ${by}`, ...r.reasons.filter((x) => !x.startsWith("EDIT_DRY_RUN") && !x.startsWith("EDITED_IN_QBO"))].slice(0, 12),
    qbo: { ...r.qbo, lastEditedAt: result.dryRun ? r.qbo.lastEditedAt ?? null : now(), lastEditDryRun: result.dryRun ? result.payload : null },
  }));
  const shared = await loadSharedContext().catch(() => null);
  const orders = shared && before.vendorName ? ordersForSupplier(before.vendorName, domainOf(rec.arrivals[rec.arrivals.length - 1]?.from), shared) : [];
  await logDecision({ record: saved, action: "edit_posted", by, proposed: before, final: after, dryRun: result.dryRun, ctx: { projects: shared?.projects, orders, autopilot: shared?.autopilot } });
  return saved;
}

export type { ResolveOverrides, SupplierProfile };
