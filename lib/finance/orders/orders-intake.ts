// Orders intake: the orders mailboxes → supplier acknowledgements / order
// confirmations as PDF attachments OR plain email bodies → supplier (sender
// address or domain, else name in the text) → purchase order (PO reference in
// the subject / file name / text, else the customer's name, else the single
// order awaiting acknowledgement for that supplier) → ack applied to the order
// through ack-apply (status, differences, acknowledged supplier cost, project
// note, a brief when there are differences).
//
// Records: ORDERACK#<sha256> (one per distinct document, arrivals appended),
// CURSOR#ORDERS#<mailbox> (watermark per mailbox), HEALTH#ORDERS#<mailbox>.
// Document bytes live only in evidence custody; mail and document text are
// untrusted data. The mail provider (Graph or IMAP) is reached only through
// lib/mail, under a per-run call budget.
import { all } from "@/lib/core/store";
import { FinanceError, bytesHash } from "@/lib/core/domain";
import { company, evidence, financeStore } from "@/lib/core/server";
import { getConnections, type Connections } from "@/lib/core/config";
import { domainOf, normName } from "@/lib/core/text";
import { accountsMailbox, intakeMailboxes, mailProvider, ordersMailboxes, type MailAttachment, type MailMessage, type MailProvider } from "@/lib/mail";
import { listSupplierOrders, type OrderRef } from "@/lib/crm/projects";
import { listSupplierProfiles, supplierDirectory, type SupplierLike } from "@/lib/finance/suppliers";
import type { AckDiscrepancy, AckExtra, AckLine, OrderStatus } from "@/lib/crm/types";
import { extractAck, pdfToText, type AckExtraction, type AckExtractor } from "./ack-extraction";
import { applyAck } from "./ack-apply";
import { looksLikeAck, findAckRef, findExpectedDate, findPoReferences, bodyAckCandidate, stripQuotedReply, hasMoneyToken, isOwnPoCopy } from "./ack-classify";

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const DEFAULT_PDF_BUDGET = 20;
const CALL_BUDGET = 150;      // mail provider calls per run, shared by the mailboxes
const BODY_BUDGET = 8;        // email bodies sent to the model per run
const LOOKBACK_DAYS = 14;
const MAX_TEXT_CHARS = 60_000;

// Statuses in which a purchase order can still receive an acknowledgement.
export const OPEN_STATUSES: OrderStatus[] = ["signed_off", "sent", "acknowledged", "discrepancy"];
// Statuses that mean "with the supplier, awaiting their acknowledgement".
export const AWAITING_STATUSES: OrderStatus[] = ["sent"];

const GENERIC_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "yahoo.com", "yahoo.co.uk", "icloud.com", "live.com", "live.co.uk", "btinternet.com", "aol.com", "me.com"]);

// ------------------------------------------------------------------ types
export type OrderAckState = "matched" | "unmatched" | "not_ack" | "duplicate" | "rejected";
export type OrderAckKind = "pdf" | "body";
export interface OrderAckArrival { mailbox: string; messageId: string; attachmentId: string | null; fileName: string; receivedAt: string; from: string | null; subject: string | null; conversationId: string | null; }
export interface OrderAckExtraction {
  lines: AckLine[]; acknowledgementRef: string | null; expectedDate: string | null; textChars: number; extractedAt: string | null;
  extras?: AckExtra[]; subtotal?: number | null; vat?: number | null; total?: number | null; currency?: string | null;
}
export interface OrderAckRecord {
  sha256: string;
  state: OrderAckState;
  kind?: OrderAckKind; // absent on records created before email bodies were read = pdf
  arrivals: OrderAckArrival[];
  evidence: { id: string; sha256: string; contentType: string; size: number };
  supplier: { id: string | null; name: string | null; score: number; source: "domain" | "email" | "name" | "order" | "manual" | "none" };
  order: { id: string | null; reference: string | null; projectId: string | null; projectName: string | null; score: number; source: "reference" | "project" | "only_open" | "manual" | "none" };
  extraction: OrderAckExtraction | null;
  ack: { status: "match" | "discrepancy"; discrepancies: AckDiscrepancy[]; appliedAt: string; supplierCost?: number; orderedCost?: number } | null;
  reasons: string[];
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface OrdersIntakeMailboxSummary { mailbox: string; ok: boolean; error?: string; messages: number; pdfs: number; bodies: number; watermark: string | null; }
export interface OrdersIntakeRunSummary {
  skipped?: string;
  startedAt: string; ms: number; mailbox: string; mailboxes: OrdersIntakeMailboxSummary[]; ok: boolean; error?: string; watermark: string | null;
  scanned: number; pdfs: number; bodies: number; mailCalls: number;
  created: number; arrivals: number; matched: number; unmatched: number; notAck: number; duplicate: number;
  items: { sha256: string; state: OrderAckState; kind: OrderAckKind; supplier: string | null; order: string | null; lines: number; discrepancies: number; reasons: string[]; fileName: string }[];
  errors: string[];
}
// Test seams: a fake mail provider / extractor / config instead of the live ones.
export interface OrdersIntakeDeps { cfg?: Connections; provider?: MailProvider; extract?: AckExtractor }

const key = { ack: (sha: string) => `ORDERACK#${sha}`, cursor: (mb: string) => `CURSOR#ORDERS#${mb.toLowerCase()}`, health: (mb: string) => `HEALTH#ORDERS#${mb.toLowerCase()}` };
const now = () => new Date().toISOString();
const SHA = /^[a-f0-9]{64}$/;

// ------------------------------------------------------------ call budget
// Every provider call counts, whichever backend answers; a run can never spin
// on one mailbox and starve the others.
class CallBudget {
  calls = 0;
  constructor(readonly provider: MailProvider, readonly max: number) {}
  get exhausted() { return this.calls >= this.max; }
  private take() { if (this.exhausted) throw new FinanceError("MAIL_BUDGET_EXHAUSTED", true, 429); this.calls += 1; }
  async list(mailbox: string, opts: { since?: string; top?: number }): Promise<MailMessage[]> {
    this.take();
    const r = await this.provider.listMessages(mailbox, { folder: "inbox", ...opts });
    this.calls += Math.max(0, (r.calls || 1) - 1);
    return r.messages;
  }
  async attachments(mailbox: string, id: string): Promise<MailAttachment[]> { this.take(); return this.provider.listAttachments(mailbox, id); }
  async attachment(mailbox: string, id: string, attachmentId: string): Promise<Uint8Array> { this.take(); return this.provider.getAttachment(mailbox, id, attachmentId); }
  async message(mailbox: string, id: string) { this.take(); return this.provider.getMessage(mailbox, id); }
}

const isPdfAttachment = (a: MailAttachment) => {
  const ct = (a.contentType || "").toLowerCase(); const name = (a.name || "").toLowerCase();
  if (a.isInline) return false;
  if (ct.startsWith("image/")) return false;
  return ct === "application/pdf" || ct === "application/x-pdf" || ((ct === "application/octet-stream" || ct === "") && name.endsWith(".pdf"));
};

// ------------------------------------------------------------ run the job
interface RunCtx {
  summary: OrdersIntakeRunSummary; budget: CallBudget; pdfBudget: number; since: string | null; by: string;
  sharedCtx: () => Promise<SharedContext>; perMailboxCalls: number;
}

export async function runOrdersIntakeJob(opts: { limit?: number; since?: string; force?: boolean; by?: string; mailbox?: string } = {}, deps: OrdersIntakeDeps = {}): Promise<OrdersIntakeRunSummary> {
  const startedAt = now(); const t0 = Date.now();
  const cfg = deps.cfg ?? (await getConnections());
  const mailboxes = ordersMailboxes(cfg).filter((m) => !opts.mailbox || m === opts.mailbox.toLowerCase());
  const summary: OrdersIntakeRunSummary = {
    startedAt, ms: 0, mailbox: mailboxes[0] || "", mailboxes: [], ok: true, watermark: null,
    scanned: 0, pdfs: 0, bodies: 0, mailCalls: 0, created: 0, arrivals: 0, matched: 0, unmatched: 0, notAck: 0, duplicate: 0, items: [], errors: [],
  };
  if (!cfg.intake.ordersEnabled && !opts.force) return { ...summary, skipped: "orders intake is switched off (intake.ordersEnabled)" };
  if (!mailboxes.length) return { ...summary, skipped: opts.mailbox ? `${opts.mailbox} is not one of the orders mailboxes` : "no orders mailbox configured" };

  let provider: MailProvider;
  try { provider = deps.provider ?? (await mailProvider(cfg)); }
  catch (e) { return { ...summary, ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 }; }

  const budget = new CallBudget(provider, CALL_BUDGET);
  const pdfBudget = Math.max(1, Math.min(opts.limit ?? DEFAULT_PDF_BUDGET, 100));
  const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
  if (opts.since && Number.isNaN(sinceMs)) throw new FinanceError("SINCE_INVALID", false, 422);
  const since = opts.since ? new Date(sinceMs).toISOString() : null;
  let shared: SharedContext | null = null;
  const ctx: RunCtx = {
    summary, budget, pdfBudget, since, by: opts.by || "orders-intake",
    sharedCtx: async () => (shared ??= await loadSharedContext(cfg, deps.extract)),
    perMailboxCalls: Math.max(30, Math.floor(CALL_BUDGET / Math.max(1, mailboxes.length))),
  };

  for (const mailbox of mailboxes) {
    const mbSummary: OrdersIntakeMailboxSummary = { mailbox, ok: true, messages: 0, pdfs: 0, bodies: 0, watermark: null };
    summary.mailboxes.push(mbSummary);
    if (budget.exhausted) { mbSummary.ok = false; mbSummary.error = "Mail call budget exhausted before this mailbox"; continue; }
    try {
      await scanMailbox(mailbox, mbSummary, ctx);
    } catch (e) {
      mbSummary.ok = false; mbSummary.error = e instanceof Error ? e.message : String(e);
      summary.errors.push(`${mailbox}: ${mbSummary.error}`);
    }
  }
  const first = summary.mailboxes[0];
  summary.ok = summary.mailboxes.every((m) => m.ok);
  if (!summary.ok) summary.error = summary.mailboxes.filter((m) => !m.ok).map((m) => `${m.mailbox}: ${m.error}`).join("; ");
  summary.watermark = first?.watermark ?? null;
  summary.mailCalls = budget.calls;
  summary.ms = Date.now() - t0;
  return summary;
}

async function scanMailbox(mailbox: string, mbSummary: OrdersIntakeMailboxSummary, ctx: RunCtx): Promise<void> {
  const { summary, budget, pdfBudget, since, by } = ctx;
  const store = financeStore(); const c = company();
  const startCalls = budget.calls;
  const overCap = () => budget.calls - startCalls >= ctx.perMailboxCalls;

  const probe = await budget.provider.probe(mailbox);
  const healthRow = await store.get(c, key.health(mailbox));
  if (!probe.ok) {
    mbSummary.ok = false; mbSummary.error = probe.error || "unreachable";
    await store.transact(c, [{ key: key.health(mailbox), expected: healthRow?.version ?? null, data: { ok: false, error: probe.error || "unreachable", checkedAt: now() } }]).catch(() => {});
    summary.errors.push(`${mailbox}: ${mbSummary.error}`);
    return;
  }
  await store.transact(c, [{ key: key.health(mailbox), expected: healthRow?.version ?? null, data: { ok: true, error: null, checkedAt: now() } }]).catch(() => {});

  // Watermark: the last fully processed receive time, plus the ids already
  // done at exactly that time (the listing filter is inclusive).
  const cursorRow = await store.get<{ receivedDateTime: string; seenIds: string[] }>(c, key.cursor(mailbox));
  let watermark = since || cursorRow?.data?.receivedDateTime || new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  let seen = new Set<string>(since ? [] : cursorRow?.data?.seenIds || []);
  let cursorVersion = cursorRow?.version ?? null;
  const saveCursor = async (receivedDateTime: string, ids: string[]) => {
    const data = { receivedDateTime, seenIds: ids.slice(-200), updatedAt: now() };
    await store.transact(c, [{ key: key.cursor(mailbox), expected: cursorVersion, data }]);
    cursorVersion = (cursorVersion ?? 0) + 1;
    watermark = receivedDateTime; seen = new Set(data.seenIds); mbSummary.watermark = receivedDateTime;
  };
  mbSummary.watermark = watermark;

  const shared = await ctx.sharedCtx();
  const account = (out: { created: boolean; record: OrderAckRecord }, fileName: string) => {
    if (!out.created) { summary.arrivals += 1; return; }
    summary.created += 1;
    const rec = out.record;
    if (rec.state === "matched") summary.matched += 1; else if (rec.state === "not_ack") summary.notAck += 1; else if (rec.state === "duplicate") summary.duplicate += 1; else summary.unmatched += 1;
    summary.items.push({ sha256: rec.sha256, state: rec.state, kind: rec.kind || "pdf", supplier: rec.supplier.name, order: rec.order.reference, lines: rec.extraction?.lines.length || 0, discrepancies: rec.ack?.discrepancies.length || 0, reasons: rec.reasons, fileName });
  };

  const top = Math.min(50, Math.max(10, pdfBudget));
  let more = true;
  while (more && !budget.exhausted && !overCap() && summary.pdfs < pdfBudget) {
    const page = await budget.list(mailbox, { since: watermark, top });
    // IMAP's SINCE is day-granular, so drop anything older than the watermark ourselves.
    const messages = page.filter((m) => m.receivedAt >= watermark && !seen.has(m.id)).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    if (!messages.length) break;
    summary.scanned += messages.length; mbSummary.messages += messages.length;
    let lastDone: MailMessage | null = null;
    const doneIds: string[] = [...page.filter((m) => seen.has(m.id)).map((m) => m.id)];
    let stoppedEarly = false;
    for (const m of messages) {
      const from = m.from.address || null;
      const subject = (m.subject || "").slice(0, 200) || null;
      try {
        let hadPdf = false;
        if (m.hasAttachments !== false) {
          if (summary.pdfs >= pdfBudget || budget.calls + 2 > budget.max || overCap()) { stoppedEarly = true; break; }
          const atts = await budget.attachments(mailbox, m.id);
          for (const a of atts.filter(isPdfAttachment)) {
            hadPdf = true;
            if (summary.pdfs >= pdfBudget || budget.exhausted) { stoppedEarly = true; break; }
            if ((a.size || 0) > MAX_PDF_BYTES) { summary.errors.push(`${m.id}/${a.name}: over 10 MB, skipped`); continue; }
            let bytes: Uint8Array;
            try { bytes = await budget.attachment(mailbox, m.id, a.id); }
            catch (e) { summary.errors.push(`${m.id}/${a.name}: ${e instanceof Error ? e.message : String(e)}`); if (e instanceof FinanceError && e.code === "MAIL_BUDGET_EXHAUSTED") throw e; continue; }
            if (bytes.length > MAX_PDF_BYTES) { summary.errors.push(`${m.id}/${a.name}: over 10 MB, skipped`); continue; }
            summary.pdfs += 1; mbSummary.pdfs += 1;
            const arrival: OrderAckArrival = { mailbox, messageId: m.id, attachmentId: a.id, fileName: a.name || "attachment.pdf", receivedAt: m.receivedAt, from, subject, conversationId: m.conversationId || null };
            try {
              account(await ingestDocument({ kind: "pdf", bytes }, arrival, shared, by), arrival.fileName);
            } catch (e) {
              summary.errors.push(`${m.id}/${a.name}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          if (stoppedEarly) break;
        }
        // No PDF: is the acknowledgement in the email body itself?
        if (!hadPdf && summary.bodies < BODY_BUDGET) {
          const pre = bodyAckCandidate({ from, subject, preview: m.preview || null }, shared.domains, shared.emails, shared.internalDomains);
          if (pre.candidate) {
            if (budget.calls + 1 > budget.max || overCap()) { stoppedEarly = true; break; }
            const full = await budget.message(mailbox, m.id);
            const text = stripQuotedReply(String(full.body?.text || "")).slice(0, MAX_TEXT_CHARS);
            summary.bodies += 1; mbSummary.bodies += 1;
            const arrival: OrderAckArrival = { mailbox, messageId: m.id, attachmentId: null, fileName: `${(subject || "message").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || "message"}.txt`, receivedAt: m.receivedAt, from, subject, conversationId: m.conversationId || null };
            try {
              account(await ingestDocument({ kind: "body", text, dedupeKey: full.internetMessageId || m.internetMessageId || m.id, preReason: pre.reason }, arrival, shared, by), arrival.fileName);
            } catch (e) {
              summary.errors.push(`${m.id}/body: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
        lastDone = m; doneIds.push(m.id);
      } catch (e) {
        summary.errors.push(`${m.id}: ${e instanceof Error ? e.message : String(e)}`);
        if (e instanceof FinanceError && e.code === "MAIL_BUDGET_EXHAUSTED") { stoppedEarly = true; break; }
        lastDone = m; doneIds.push(m.id); // a broken message must not block the mailbox forever
      }
    }
    // Advance the watermark only over messages that were fully processed.
    if (lastDone) {
      const ts = lastDone.receivedAt;
      const sameTs = doneIds.filter((id) => page.find((x) => x.id === id)?.receivedAt === ts);
      await saveCursor(ts, [...Array.from(seen).filter((id) => page.find((x) => x.id === id)?.receivedAt === ts), ...sameTs]);
    }
    if (stoppedEarly) break;
    more = page.length >= top; // a short page means the mailbox is drained
  }
}

// ------------------------------------------------------------ shared ctx
interface SharedContext { suppliers: SupplierLike[]; domains: Set<string>; emails: Set<string>; internalDomains: Set<string>; ownPoMarkers: string[]; extract: AckExtractor; }
async function loadSharedContext(cfg: Connections, extract?: AckExtractor): Promise<SharedContext> {
  const suppliers = supplierDirectory(await listSupplierProfiles().catch(() => []))
    .map((s) => ({ ...s, domains: s.domains.filter((d) => !GENERIC_DOMAINS.has(d)) }));
  // Our own people: the configured internal domains, plus the domains of the
  // watched mailboxes unless they sit on a public mail service.
  const mailboxDomains = [...ordersMailboxes(cfg), ...intakeMailboxes(cfg), accountsMailbox(cfg) || "", cfg.company.ownerEmail].map(domainOf).filter((d): d is string => !!d && !GENERIC_DOMAINS.has(d));
  const internalDomains = new Set([...cfg.company.internalDomains.map((d) => d.toLowerCase()), ...mailboxDomains]);
  return {
    suppliers, domains: new Set(suppliers.flatMap((s) => s.domains)), emails: new Set(suppliers.flatMap((s) => s.emails)),
    internalDomains, ownPoMarkers: [cfg.company.name, ...internalDomains].filter(Boolean),
    extract: extract ?? ((text) => extractAck(text, cfg)),
  };
}

// --------------------------------------------------------------- matching
type SupplierMatch = OrderAckRecord["supplier"];
type OrderMatch = OrderAckRecord["order"];
const noSupplier: SupplierMatch = { id: null, name: null, score: 0, source: "none" };
const noOrder: OrderMatch = { id: null, reference: null, projectId: null, projectName: null, score: 0, source: "none" };
const orderMatch = (o: OrderRef, score: number, source: OrderMatch["source"]): OrderMatch => ({ id: o.id, reference: o.reference, projectId: o.projectId, projectName: o.projectName, score, source });

function matchSupplier(shared: SharedContext, from: string | null, text: string, reasons: string[]): SupplierMatch {
  const sender = (from || "").toLowerCase();
  const domain = domainOf(sender);
  if (sender) {
    const byEmail = shared.suppliers.find((s) => s.emails.includes(sender));
    if (byEmail) return { id: byEmail.id, name: byEmail.name, score: 1, source: "email" };
  }
  if (domain && !GENERIC_DOMAINS.has(domain)) {
    const byDomain = shared.suppliers.filter((s) => s.domains.includes(domain));
    if (byDomain.length === 1) return { id: byDomain[0].id, name: byDomain[0].name, score: 0.95, source: "domain" };
    if (byDomain.length > 1) reasons.push(`SUPPLIER_DOMAIN_AMBIGUOUS:${byDomain.map((s) => s.name).join("|")}`);
  }
  // Name in the document text (normalised, longest name wins).
  const textNorm = ` ${normName(text.slice(0, MAX_TEXT_CHARS))} `;
  const byName = shared.suppliers.filter((s) => s.norm.length > 3 && textNorm.includes(` ${s.norm} `)).sort((a, b) => b.norm.length - a.norm.length);
  if (byName.length) {
    if (byName.length > 1) reasons.push(`SUPPLIER_NAME_CANDIDATES:${byName.slice(0, 4).map((s) => s.name).join("|")}`);
    return { id: byName[0].id, name: byName[0].name, score: byName.length === 1 ? 0.8 : 0.6, source: "name" };
  }
  reasons.push(domain ? `SUPPLIER_UNKNOWN:${domain}` : "SUPPLIER_UNKNOWN");
  return noSupplier;
}

const wordHit = (text: string, word: string) => new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i").test(text);

// CRM orders do not always carry the supplier profile id, so "this supplier's
// orders" means the id when present, else the same normalised supplier name.
const sameSupplier = (o: OrderRef, supplier: SupplierMatch) => (!!supplier.id && o.supplierId === supplier.id) || (!!supplier.name && normName(o.supplierName) === normName(supplier.name));
async function ordersFor(supplier: SupplierMatch | null): Promise<OrderRef[]> {
  const pool = await listSupplierOrders().catch(() => [] as OrderRef[]);
  return supplier?.id ? pool.filter((o) => sameSupplier(o, supplier)) : pool;
}

async function matchOrder(supplier: SupplierMatch, hay: string, text: string, reasons: string[]): Promise<{ order: OrderMatch; supplier: SupplierMatch; po: OrderRef | null }> {
  // 1. PO reference anywhere in subject / filename / text — strongest signal; may also tell us the supplier.
  const refs = findPoReferences(hay);
  if (refs.length) {
    const pool = await ordersFor(supplier.id ? supplier : null);
    const hit = pool.filter((o) => refs.includes(o.reference.toUpperCase()) && o.status !== "cancelled");
    if (hit.length === 1) {
      const o = hit[0];
      const sup: SupplierMatch = supplier.id ? supplier : { id: o.supplierId ?? null, name: o.supplierName, score: 0.9, source: "order" };
      if (supplier.id && !sameSupplier(o, supplier)) reasons.push(`SUPPLIER_MISMATCH:ref says ${o.supplierName}`);
      // The owner has already confirmed this order — never overwrite silently; leave it for review.
      if (o.status === "confirmed") {
        reasons.push(`ORDER_ALREADY_CONFIRMED:${o.reference} — match manually if this revision should replace the confirmed acknowledgement`);
        return { order: { ...orderMatch(o, 0.9, "reference"), id: null }, supplier: sup, po: null };
      }
      return { order: orderMatch(o, 1, "reference"), supplier: sup, po: o };
    }
    if (hit.length > 1) reasons.push(`PO_REFERENCE_AMBIGUOUS:${hit.map((o) => o.reference).join("|")}`);
    else reasons.push(`PO_REFERENCE_NOT_FOUND:${refs.join("|")}`);
  }
  if (!supplier.id) { reasons.push("ORDER_NEEDS_SUPPLIER"); return { order: noOrder, supplier, po: null }; }

  const orders = (await ordersFor(supplier)).filter((o) => OPEN_STATUSES.includes(o.status));
  if (!orders.length) { reasons.push("NO_OPEN_ORDERS_FOR_SUPPLIER"); return { order: noOrder, supplier, po: null }; }

  // 2. Customer name (full name, else surname) in the text.
  const lower = text.toLowerCase();
  const textNorm = ` ${normName(text.slice(0, MAX_TEXT_CHARS))} `;
  const scored = orders.map((o) => {
    const full = normName(o.projectName || "");
    const parts = (o.projectName || "").trim().split(/\s+/).filter(Boolean);
    const surname = (o.clientSurname || parts[parts.length - 1] || "").toLowerCase();
    const fullHit = full.length > 3 && textNorm.includes(` ${full} `);
    const surnameHit = surname.length >= 3 && wordHit(lower, surname);
    const postcodeHit = !!o.clientPostcode && lower.includes(o.clientPostcode.toLowerCase());
    return { o, score: fullHit ? 0.85 : surnameHit ? (postcodeHit ? 0.8 : 0.7) : 0 };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || (b.o.sentAt || b.o.createdAt).localeCompare(a.o.sentAt || a.o.createdAt));
  if (scored.length) {
    const projects = new Set(scored.map((x) => x.o.projectId));
    if (projects.size === 1) {
      const awaiting = scored.filter((x) => AWAITING_STATUSES.includes(x.o.status));
      const pick = awaiting.length === 1 ? awaiting[0] : scored.length === 1 ? scored[0] : null;
      if (pick) return { order: orderMatch(pick.o, pick.score, "project"), supplier, po: pick.o };
      reasons.push(`PROJECT_ORDERS_AMBIGUOUS:${scored.map((x) => x.o.reference).join("|")}`);
      return { order: { ...orderMatch(scored[0].o, 0.4, "project"), id: null }, supplier, po: null };
    }
    reasons.push(`PROJECT_NAME_AMBIGUOUS:${scored.slice(0, 4).map((x) => `${x.o.reference} ${x.o.projectName}`).join("|")}`);
    return { order: noOrder, supplier, po: null };
  }

  // 3. Exactly one order with this supplier is awaiting acknowledgement.
  const awaiting = orders.filter((o) => AWAITING_STATUSES.includes(o.status));
  if (awaiting.length === 1) return { order: orderMatch(awaiting[0], 0.6, "only_open"), supplier, po: awaiting[0] };
  reasons.push(awaiting.length ? `OPEN_ORDERS_AMBIGUOUS:${awaiting.map((o) => o.reference).join("|")}` : `NO_ORDER_AWAITING_ACK:${orders.map((o) => `${o.reference}(${o.status})`).slice(0, 5).join("|")}`);
  return { order: noOrder, supplier, po: null };
}

// ------------------------------------------------------- apply to order
const sameLines = (a: AckLine[], b: AckLine[]) => a.length === b.length && a.every((l, i) => (l.code || "").trim().toLowerCase() === (b[i].code || "").trim().toLowerCase() && Math.abs(l.qty - b[i].qty) < 0.001 && Math.abs(l.unitCost - b[i].unitCost) < 0.005);
const sameExtras = (a: AckExtra[] | undefined, b: AckExtra[] | undefined) => JSON.stringify((a || []).map((x) => [x.label.toLowerCase(), Math.round(x.amount * 100)])) === JSON.stringify((b || []).map((x) => [x.label.toLowerCase(), Math.round(x.amount * 100)]));
const toExtraction = (x: AckExtraction, text: string): OrderAckExtraction => ({
  lines: x.lines.slice(0, 200), acknowledgementRef: x.supplierRef ?? findAckRef(text), expectedDate: x.expectedDate ?? findExpectedDate(text),
  extras: x.extras, subtotal: x.subtotal, vat: x.vat, total: x.total, currency: x.currency, textChars: text.length, extractedAt: now(),
});

async function applyToOrder(order: OrderRef, x: AckExtraction, extraction: OrderAckExtraction, arrival: OrderAckArrival, kind: OrderAckKind, by: string, how: string) {
  const applied = await applyAck(order, {
    lines: x.lines, extras: x.extras, supplierRef: extraction.acknowledgementRef, expectedDate: extraction.expectedDate,
    subtotal: x.subtotal, vat: x.vat, total: x.total, currency: x.currency,
  }, {
    filename: arrival.fileName, receivedAt: arrival.receivedAt || now(), extractedBy: "ai", source: kind, mailbox: arrival.mailbox, messageId: arrival.messageId, by, how,
  });
  return { status: applied.status, discrepancies: applied.discrepancies, appliedAt: now(), supplierCost: applied.totals.acknowledgedCost, orderedCost: applied.totals.orderedCost };
}

// ------------------------------------------------------------- ingest one
type DocInput = { kind: "pdf"; bytes: Uint8Array } | { kind: "body"; text: string; dedupeKey: string; preReason: string };

async function ingestDocument(doc: DocInput, arrival: OrderAckArrival, shared: SharedContext, by: string): Promise<{ created: boolean; record: OrderAckRecord }> {
  const store = financeStore(); const c = company();
  const bytes = doc.kind === "pdf" ? doc.bytes : new Uint8Array(Buffer.from(doc.text, "utf8"));
  // Same PDF forwarded twice = one record; the same email CC'd to two of our mailboxes = one record.
  const sha256 = doc.kind === "pdf" ? bytesHash(bytes) : bytesHash(new Uint8Array(Buffer.from(`${doc.dedupeKey}\n${doc.text}`, "utf8")));
  const contentType = doc.kind === "pdf" ? "application/pdf" : "text/plain";
  const existing = await store.get<OrderAckRecord>(c, key.ack(sha256));
  if (existing) {
    const dup = existing.data.arrivals.some((a) => a.messageId === arrival.messageId && a.attachmentId === arrival.attachmentId);
    if (dup) return { created: false, record: existing.data };
    const nextRec: OrderAckRecord = { ...existing.data, arrivals: [...existing.data.arrivals, arrival].slice(-20), updatedAt: now() };
    await store.transact(c, [{ key: key.ack(sha256), expected: existing.version, data: nextRec }]);
    return { created: false, record: nextRec };
  }
  const put = await evidence().put(c, bytes, contentType);
  const reasons: string[] = [];
  let rec: OrderAckRecord = {
    sha256, state: "unmatched", kind: doc.kind, arrivals: [arrival], evidence: { id: put.id, sha256: put.sha256, contentType, size: bytes.length },
    supplier: noSupplier, order: noOrder, extraction: null, ack: null, reasons, decidedBy: null, decidedAt: null, createdAt: now(), updatedAt: now(),
  };

  let text = "";
  if (doc.kind === "pdf") {
    try { text = (await pdfToText(bytes)).slice(0, MAX_TEXT_CHARS); }
    catch (e) { reasons.push(`PDF_TEXT_FAILED:${e instanceof Error ? e.message.slice(0, 80) : "unknown"}`); }
    if (!text.trim()) reasons.push("PDF_NO_TEXT");
  } else {
    text = doc.text;
    reasons.push(`BODY:${doc.preReason}`);
  }

  const notAck = async (why: string) => {
    reasons.push(why);
    rec = { ...rec, state: "not_ack", supplier: matchSupplier(shared, arrival.from, text, []), updatedAt: now() };
    await store.transact(c, [{ key: key.ack(sha256), expected: null, data: rec }]);
    return { created: true, record: rec };
  };
  if (doc.kind === "pdf" && isOwnPoCopy(arrival.fileName, text, shared.ownPoMarkers)) return notAck("OWN_PO_COPY");
  const cls = looksLikeAck(text, arrival.subject, arrival.fileName);
  if (!cls.ack) return notAck(cls.reason);
  reasons.push(cls.reason);
  if (doc.kind === "body" && !hasMoneyToken(text)) return notAck("BODY_NO_PRICES");

  // Supplier, then order.
  const hay = `${arrival.subject || ""}\n${arrival.fileName}\n${text}`;
  let supplier = matchSupplier(shared, arrival.from, text, reasons);
  const m = await matchOrder(supplier, hay, text, reasons);
  supplier = m.supplier;
  rec = { ...rec, supplier, order: m.order };

  // Structured extraction (model call) only for acknowledgements.
  let x: AckExtraction = { supplierRef: null, expectedDate: null, currency: null, lines: [], extras: [], subtotal: null, vat: null, total: null };
  try { x = await shared.extract(text); }
  catch (e) { reasons.push(`EXTRACTION_FAILED:${e instanceof Error ? e.message.slice(0, 120) : "unknown"}`); }
  rec.extraction = toExtraction(x, text);
  if (!x.lines.length) reasons.push("NO_LINES_EXTRACTED");

  const confident = !!m.po && (m.order.source === "reference" || m.order.source === "project" || m.order.source === "only_open");
  if (confident && m.po && x.lines.length) {
    if (m.po.ack && sameLines(m.po.ack.lines, x.lines) && sameExtras(m.po.ack.extras, x.extras)) {
      rec.state = "duplicate"; reasons.unshift(`DUPLICATE_ACK_ON:${m.po.reference}`);
    } else {
      if (m.po.ack) reasons.push("ACK_REVISED:replaces the acknowledgement already on the order");
      const applied = await applyToOrder(m.po, x, rec.extraction, arrival, doc.kind, by, `matched by ${m.order.source}${doc.kind === "body" ? " (email body)" : ""}`);
      rec.state = "matched"; rec.ack = applied;
      reasons.unshift(applied.status === "match" ? "LINES_MATCH" : `DIFFERENCES:${applied.discrepancies.length}`);
    }
  } else if (m.po && !x.lines.length) {
    reasons.push("ORDER_FOUND_BUT_NO_LINES:match manually to retry extraction");
  }
  rec.updatedAt = now();
  await store.transact(c, [{ key: key.ack(sha256), expected: null, data: rec }]);
  return { created: true, record: rec };
}

// ------------------------------------------------------------------ reads
export async function getOrderAck(sha256: string): Promise<OrderAckRecord | null> {
  if (!SHA.test(sha256)) return null;
  const row = await financeStore().get<OrderAckRecord>(company(), key.ack(sha256));
  return row?.data?.sha256 ? row.data : null;
}

export async function listOrderAcks(filter: { state?: OrderAckState | "all" | "open"; limit?: number } = {}): Promise<OrderAckRecord[]> {
  const rows = await all<OrderAckRecord>(financeStore(), company(), "ORDERACK#");
  const state = filter.state || "open";
  return rows.map((r) => r.data).filter((d) => d && typeof d.sha256 === "string" && Array.isArray(d.arrivals))
    .filter((d) => state === "all" ? true : state === "open" ? d.state === "unmatched" : d.state === state)
    .sort((a, b) => (b.arrivals[0]?.receivedAt || b.createdAt).localeCompare(a.arrivals[0]?.receivedAt || a.createdAt))
    .slice(0, Math.max(1, Math.min(filter.limit ?? 100, 500)));
}

// The stored evidence: the PDF, or the plain-text email body.
export async function readOrderAckEvidence(sha256: string): Promise<{ bytes: Uint8Array; fileName: string; contentType: string } | null> {
  const rec = await getOrderAck(sha256);
  if (!rec) return null;
  const bytes = await evidence().read(company(), rec.evidence.id);
  const contentType = rec.evidence.contentType || "application/pdf";
  const fallback = contentType === "text/plain" ? `${sha256.slice(0, 12)}.txt` : `${sha256.slice(0, 12)}.pdf`;
  return { bytes, fileName: rec.arrivals[0]?.fileName || fallback, contentType };
}
export const readOrderAckPdf = readOrderAckEvidence;

export interface OrdersMailboxHealth { mailbox: string; enabled: boolean; ok: boolean | null; error: string | null; checkedAt: string | null; watermark: string | null; }
export async function ordersIntakeHealth(cfg?: Connections): Promise<OrdersMailboxHealth & { mailboxes: OrdersMailboxHealth[] }> {
  const store = financeStore(); const c = company();
  const conf = cfg ?? (await getConnections());
  const enabled = conf.intake.ordersEnabled;
  const mailboxes = await Promise.all(ordersMailboxes(conf).map(async (mb) => {
    const [h, cur] = await Promise.all([
      store.get<{ ok: boolean; error: string | null; checkedAt: string }>(c, key.health(mb)),
      store.get<{ receivedDateTime: string }>(c, key.cursor(mb)),
    ]);
    return { mailbox: mb, enabled, ok: h?.data?.ok ?? null, error: h?.data?.error ?? null, checkedAt: h?.data?.checkedAt ?? null, watermark: cur?.data?.receivedDateTime ?? null };
  }));
  const first: OrdersMailboxHealth = mailboxes[0] || { mailbox: "", enabled, ok: null, error: "no orders mailbox configured", checkedAt: null, watermark: null };
  return { ...first, mailboxes };
}

// Open purchase orders a reviewer can match an acknowledgement to.
export async function openOrdersForMatching(supplierId?: string | null): Promise<Pick<OrderRef, "id" | "reference" | "projectId" | "projectName" | "supplierId" | "supplierName" | "status" | "sentAt" | "createdAt">[]> {
  const orders = await listSupplierOrders(supplierId ? { supplierId } : {});
  return orders.filter((o) => OPEN_STATUSES.includes(o.status)).map((o) => ({ id: o.id, reference: o.reference, projectId: o.projectId, projectName: o.projectName, supplierId: o.supplierId ?? null, supplierName: o.supplierName, status: o.status, sentAt: o.sentAt ?? null, createdAt: o.createdAt }));
}

export async function getOrderById(orderId: string): Promise<OrderRef | null> {
  return (await listSupplierOrders()).find((o) => o.id === orderId) ?? null;
}

// ---------------------------------------------------------------- actions
async function updateRecord(sha256: string, patch: (r: OrderAckRecord) => OrderAckRecord | Promise<OrderAckRecord>): Promise<OrderAckRecord> {
  const store = financeStore(); const c = company();
  if (!SHA.test(sha256)) throw new FinanceError("BAD_SHA", false, 400);
  const row = await store.get<OrderAckRecord>(c, key.ack(sha256));
  if (!row?.data?.sha256) throw new FinanceError("ORDERACK_NOT_FOUND", false, 404);
  const next = { ...(await patch(row.data)), updatedAt: now() };
  await store.transact(c, [{ key: key.ack(sha256), expected: row.version, data: next }]);
  return next;
}

async function evidenceText(r: OrderAckRecord): Promise<string> {
  const bytes = await evidence().read(company(), r.evidence.id);
  if ((r.kind || "pdf") === "body" || r.evidence.contentType === "text/plain") return Buffer.from(bytes).toString("utf8").slice(0, MAX_TEXT_CHARS);
  return (await pdfToText(bytes)).slice(0, MAX_TEXT_CHARS);
}

// Manual match from the review queue / an agent: attach this acknowledgement to
// the chosen purchase order (re-extracting when the run had no lines).
export async function matchOrderAck(sha256: string, orderId: string, by: string, deps: Pick<OrdersIntakeDeps, "cfg" | "extract"> = {}): Promise<OrderAckRecord> {
  const order = await getOrderById(orderId);
  if (!order) throw new FinanceError("ORDER_NOT_FOUND", false, 404);
  if (order.status === "cancelled") throw new FinanceError("ORDER_CANCELLED", false, 409);
  return updateRecord(sha256, async (r) => {
    let extraction = r.extraction;
    let x: AckExtraction = {
      supplierRef: extraction?.acknowledgementRef ?? null, expectedDate: extraction?.expectedDate ?? null, currency: extraction?.currency ?? null,
      lines: extraction?.lines || [], extras: extraction?.extras || [], subtotal: extraction?.subtotal ?? null, vat: extraction?.vat ?? null, total: extraction?.total ?? null,
    };
    if (!x.lines.length) {
      const text = await evidenceText(r);
      x = deps.extract ? await deps.extract(text) : await extractAck(text, deps.cfg);
      extraction = toExtraction(x, text);
    }
    if (!x.lines.length) throw new FinanceError("ACK_NO_LINES: could not extract line items — record the acknowledgement on the order by hand", false, 422);
    const arrival = r.arrivals[r.arrivals.length - 1];
    const applied = await applyToOrder(order, x, extraction!, arrival, r.kind || "pdf", by, `matched manually by ${by}`);
    return {
      ...r, state: "matched", extraction,
      supplier: { id: order.supplierId ?? null, name: order.supplierName, score: 1, source: "manual" },
      order: { id: order.id, reference: order.reference, projectId: order.projectId, projectName: order.projectName, score: 1, source: "manual" },
      ack: applied,
      reasons: [`MATCHED_BY:${by.slice(0, 80)}`, applied.status === "match" ? "LINES_MATCH" : `DIFFERENCES:${applied.discrepancies.length}`, ...r.reasons.filter((v) => !/^(MATCHED_BY|LINES_MATCH|DISCREPANCIES|DIFFERENCES|REJECTED):?/.test(v))],
      decidedBy: by, decidedAt: now(),
    };
  });
}

export async function rejectOrderAck(sha256: string, reason: string, by: string): Promise<OrderAckRecord> {
  return updateRecord(sha256, (r) => {
    if (r.state === "matched") throw new FinanceError("ORDERACK_ALREADY_MATCHED: the acknowledgement is on the order — change it there", false, 409);
    return { ...r, state: "rejected", reasons: [`REJECTED:${reason.slice(0, 200)}`, ...r.reasons.filter((v) => !v.startsWith("REJECTED:"))], decidedBy: by, decidedAt: now() };
  });
}
