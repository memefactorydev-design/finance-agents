// Owner approvals for things the finance rules say the owner must confirm —
// today: creating a new QuickBooks vendor for an invoice from an unknown
// supplier. The request goes to the briefs channel (mirrored to Slack when a
// webhook is configured) and as an email from the accounts mailbox to the
// owner. Replies are read back from the channel (a human author) and from the
// accounts mailbox (a sender on the approver list); only an explicit
// "APPROVE <ref>" / "REJECT <ref>" is acted on. The ref is the first 8
// characters of the intake sha256. Nothing here pays or posts anything.
import { getConnections, type Connections } from "@/lib/core/config";
import { company, financeStore } from "@/lib/core/server";
import { listBriefs, postBrief } from "@/lib/finance/briefs";
import { accountsMailbox, mailProvider } from "@/lib/mail";
import { sendFromAccounts } from "@/lib/mail/outbound";
import { getIntake, listIntake, rejectIntake, setOwnerApproval, type IntakeRecord } from "./intake";

export const APPROVALS_AUTHOR = "Finance intake";
const refOf = (sha: string) => sha.slice(0, 8);
const fmt = (v: number | null | undefined, currency = "GBP") => (v == null ? "—" : new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(v));
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export interface ApprovalRequest { sha256: string; ref: string; vendor: string; docNumber: string | null; gross: number | null; sender: string | null; mailbox: string | null; requestedAt: string; channelMessageId: string | null; emailDraft: boolean }
type ApprovalRow = Omit<ApprovalRequest, "requestedAt" | "channelMessageId" | "emailDraft">;

// The owner plus anyone on the approver list.
export function approverSet(cfg: Connections): Set<string> {
  return new Set([cfg.company.ownerEmail, ...cfg.company.approverEmails].map((s) => (s || "").trim().toLowerCase()).filter(Boolean));
}
export const isApprover = (email: string | null | undefined, cfg: Connections) => !!email && approverSet(cfg).has(email.toLowerCase());

function needsApproval(r: IntakeRecord): boolean {
  if (r.state !== "proposed" || !r.resolution) return false;
  if (r.ownerApproval?.decision) return false;
  return !r.resolution.vendorId && !!r.resolution.vendorProposed;
}

const DECISION_EFFECT = "APPROVE creates the supplier in QuickBooks and lets the bill post; REJECT drops the document. Nothing is paid.";
const approvalLines = (rows: ApprovalRow[], currency: string) => rows.map((x) => `• APPROVAL NEEDED ${x.ref}: new supplier "${x.vendor}" — invoice ${x.docNumber || "(no number)"} ${fmt(x.gross, currency)} from ${x.sender || "unknown sender"} via ${x.mailbox?.split("@")[0] || "?"}@`);
const stamp = () => new Date().toISOString().slice(0, 16).replace("T", " ");

const rowOf = (r: IntakeRecord): ApprovalRow => {
  const a = r.arrivals[r.arrivals.length - 1];
  return { sha256: r.sha256, ref: r.ownerApproval?.ref || refOf(r.sha256), vendor: r.resolution?.vendorProposed?.displayName || r.extraction?.supplierIdentity || "unknown supplier", docNumber: r.resolution?.docNumber ?? r.extraction?.documentNumber ?? null, gross: r.resolution?.totals?.gross ?? null, sender: a?.from ?? null, mailbox: a?.mailbox ?? null };
};

async function emailOwner(cfg: Connections, subject: string, lines: string[], actor: string, errors: string[]): Promise<boolean> {
  if (!cfg.company.ownerEmail) { errors.push("email: no owner email configured (company.ownerEmail)"); return false; }
  try {
    await sendFromAccounts({ to: cfg.company.ownerEmail, subject, html: `<p>${lines.map((l) => esc(l.replace(/^• /, ""))).join("</p><p>")}</p><p>Reply to this email with <b>APPROVE &lt;ref&gt;</b> or <b>REJECT &lt;ref&gt;</b> per line, or reply in the briefs channel.</p>`, actor });
    return true;
  } catch (e) { errors.push(`email: ${e instanceof Error ? e.message : String(e)}`); return false; }
}

// Post every outstanding unknown-vendor proposal as one approval message (per run), once per item.
export async function requestOwnerApprovals(opts: { by?: string; dryRun?: boolean } = {}): Promise<{ requested: ApprovalRequest[]; skipped: number; channelMessageId: string | null; emailDraft: boolean; errors: string[] }> {
  const cfg = await getConnections();
  const by = opts.by || APPROVALS_AUTHOR;
  const errors: string[] = [];
  const open = (await listIntake({ state: "proposed", limit: 200 })).filter(needsApproval);
  const pending = open.filter((r) => !r.ownerApproval?.requestedAt);
  if (!pending.length) return { requested: [], skipped: open.length, channelMessageId: null, emailDraft: false, errors };
  const rows = pending.map(rowOf);
  const lines = approvalLines(rows, cfg.company.currency);
  const text = [
    `Finance approvals (${rows.length}) — ${stamp()} UTC`,
    ...lines,
    `Reply in this channel (or by email to ${accountsMailbox(cfg) || "the accounts mailbox"}) with APPROVE <ref> or REJECT <ref> — one per line is fine. ${DECISION_EFFECT}`,
  ].join("\n");
  if (opts.dryRun) return { requested: rows.map((x) => ({ ...x, requestedAt: "", channelMessageId: null, emailDraft: false })), skipped: open.length - pending.length, channelMessageId: null, emailDraft: false, errors };

  let channelMessageId: string | null = null;
  try { channelMessageId = (await postBrief({ author: by, authorKind: "agent", text, meta: { kind: "approval_request", refs: rows.map((r) => r.ref) } })).id; }
  catch (e) { errors.push(`briefs: ${e instanceof Error ? e.message : String(e)}`); }
  const emailDraft = await emailOwner(cfg, `Finance approvals needed — ${rows.length} new supplier${rows.length === 1 ? "" : "s"}`, lines, by, errors);
  const requestedAt = new Date().toISOString();
  const requested: ApprovalRequest[] = [];
  for (const x of rows) {
    await setOwnerApproval(x.sha256, { status: "requested", ref: x.ref, requestedAt, channelMessageId, decision: null, decidedBy: null, decidedAt: null, source: null }).catch((e) => errors.push(`${x.ref}: ${e instanceof Error ? e.message : String(e)}`));
    requested.push({ ...x, requestedAt, channelMessageId, emailDraft });
  }
  return { requested, skipped: open.length - pending.length, channelMessageId, emailDraft, errors };
}

// Re-send every approval that was asked for but not yet decided (a nudge from
// the cron or a tool call): one brief and one email draft to the owner.
export async function remindOwnerApprovals(opts: { by?: string } = {}): Promise<{ pending: ApprovalRequest[]; channelMessageId: string | null; emailDraft: boolean; errors: string[] }> {
  const cfg = await getConnections();
  const by = opts.by || APPROVALS_AUTHOR;
  const errors: string[] = [];
  const waiting = (await listIntake({ state: "proposed", limit: 200 })).filter((r) => r.ownerApproval?.status === "requested" && !r.ownerApproval.decision);
  if (!waiting.length) return { pending: [], channelMessageId: null, emailDraft: false, errors };
  const rows = waiting.map(rowOf);
  const lines = approvalLines(rows, cfg.company.currency);
  let channelMessageId: string | null = null;
  try { channelMessageId = (await postBrief({ author: by, authorKind: "agent", text: [`Finance approvals still waiting (${rows.length}) — ${stamp()} UTC`, ...lines, `Reply with APPROVE <ref> or REJECT <ref>. ${DECISION_EFFECT}`].join("\n"), meta: { kind: "approval_reminder", refs: rows.map((r) => r.ref) } })).id; }
  catch (e) { errors.push(`briefs: ${e instanceof Error ? e.message : String(e)}`); }
  const emailDraft = await emailOwner(cfg, `Finance approvals still waiting — ${rows.length}`, lines, by, errors);
  return { pending: rows.map((x) => ({ ...x, requestedAt: waiting.find((w) => w.sha256 === x.sha256)?.ownerApproval?.requestedAt || "", channelMessageId, emailDraft })), channelMessageId, emailDraft, errors };
}

const DECISION_RE = /\b(APPROVE|APPROVED|REJECT|REJECTED)\s+#?([a-f0-9]{6,64})\b/gi;
export const hasDecision = (text: string) => new RegExp(DECISION_RE.source, "i").test(text || "");

// APPROVE/REJECT lines typed by an approver anywhere (UI, another channel).
export async function applyDecisionText(text: string, byEmail: string, source: "briefs" | "email" | "ui" = "ui"): Promise<{ applied: string[]; errors: string[] }> {
  const cfg = await getConnections();
  const applied: string[] = []; const errors: string[] = [];
  if (!isApprover(byEmail, cfg)) { errors.push(`${byEmail} is not an approver`); return { applied, errors }; }
  const at = new Date().toISOString();
  for (const hit of (text || "").matchAll(new RegExp(DECISION_RE.source, "gi"))) await applyDecision(hit[2], /^APPROVE/i.test(hit[1]) ? "approve" : "reject", byEmail.toLowerCase(), source, at, applied, errors);
  return { applied, errors };
}

async function applyDecision(prefix: string, decision: "approve" | "reject", by: string, source: "briefs" | "email" | "ui", at: string, applied: string[], errors: string[]) {
  const matches = (await listIntake({ state: "all", limit: 500 })).filter((r) => r.sha256.startsWith(prefix.toLowerCase()));
  if (matches.length !== 1) { errors.push(`${prefix}: ${matches.length === 0 ? "no intake item" : "ambiguous ref"}`); return; }
  const rec = matches[0];
  if (rec.ownerApproval?.decision) { errors.push(`${prefix}: already ${rec.ownerApproval.status} by ${rec.ownerApproval.decidedBy || "someone"} (${(rec.ownerApproval.decidedAt || "").slice(0, 16).replace("T", " ")})`); return; }
  if (rec.state === "rejected" || rec.state === "not_invoice") { errors.push(`${prefix}: already ${rec.state} — ${rec.reasons.find((r) => r.startsWith("REJECTED:")) || "no longer waiting"}`); return; }
  await setOwnerApproval(rec.sha256, { status: decision === "approve" ? "approved" : "rejected", ref: refOf(rec.sha256), requestedAt: rec.ownerApproval?.requestedAt ?? at, channelMessageId: rec.ownerApproval?.channelMessageId ?? null, decision, decidedBy: by, decidedAt: at, source });
  if (decision === "reject") await rejectIntake(rec.sha256, `owner rejected via ${source}`, by).catch((e) => errors.push(`${prefix}: ${e instanceof Error ? e.message : String(e)}`));
  applied.push(`${prefix} ${decision} (${by}, ${source})`);
}

// Read APPROVE/REJECT replies from the briefs channel (human authors only) and
// from the accounts mailbox (senders on the approver list).
export async function applyOwnerReplies(): Promise<{ applied: string[]; scannedBriefs: number; scannedEmail: number; errors: string[] }> {
  const cfg = await getConnections();
  const store = financeStore(); const c = company();
  const applied: string[] = []; const errors: string[] = [];
  // Briefs channel: anything a human wrote since the last pass.
  let scannedBriefs = 0;
  try {
    const cursorRow = await store.get<{ since: string }>(c, "CURSOR#APPROVALS#briefs").catch(() => null);
    const since = cursorRow?.data?.since || new Date(Date.now() - 14 * 86_400_000).toISOString();
    const briefs = (await listBriefs({ since, limit: 500 })).filter((b) => b.createdAt > since).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let latest = since;
    for (const b of briefs) {
      scannedBriefs += 1;
      if (b.createdAt > latest) latest = b.createdAt;
      if (b.authorKind !== "human" && !isApprover(b.author, cfg)) continue;
      for (const hit of b.text.matchAll(new RegExp(DECISION_RE.source, "gi"))) await applyDecision(hit[2], /^APPROVE/i.test(hit[1]) ? "approve" : "reject", b.author, "briefs", b.createdAt, applied, errors);
    }
    if (latest !== since) await store.transact(c, [{ key: "CURSOR#APPROVALS#briefs", expected: cursorRow?.version ?? null, data: { since: latest } }]).catch(() => {});
  } catch (e) { errors.push(`briefs read: ${e instanceof Error ? e.message : String(e)}`); }
  // Email replies in the accounts mailbox from an approver.
  let scannedEmail = 0;
  try {
    const mailbox = accountsMailbox(cfg);
    if (!mailbox) throw new Error("no accounts mailbox configured");
    const provider = await mailProvider(cfg);
    const emailCursor = await store.get<{ receivedDateTime: string }>(c, "CURSOR#APPROVALS#email").catch(() => null);
    const after = emailCursor?.data?.receivedDateTime || new Date(Date.now() - 7 * 86_400_000).toISOString();
    const page = await provider.listMessages(mailbox, { since: after, top: 50 });
    let latest = after;
    for (const m of page.messages) {
      scannedEmail += 1;
      if (m.receivedAt > latest) latest = m.receivedAt;
      const from = (m.from?.address || "").toLowerCase();
      if (!isApprover(from, cfg)) continue;
      // Only an approver's message is opened; its content is still data, never instructions.
      const full = await provider.getMessage(mailbox, m.id);
      const text = full.body.text || String(full.body.html || "").replace(/<[^>]+>/g, " ");
      for (const hit of text.matchAll(new RegExp(DECISION_RE.source, "gi"))) await applyDecision(hit[2], /^APPROVE/i.test(hit[1]) ? "approve" : "reject", from, "email", m.receivedAt, applied, errors);
    }
    if (latest !== after) await store.transact(c, [{ key: "CURSOR#APPROVALS#email", expected: emailCursor?.version ?? null, data: { receivedDateTime: latest } }]).catch(() => {});
  } catch (e) { errors.push(`email read: ${e instanceof Error ? e.message : String(e)}`); }
  return { applied, scannedBriefs, scannedEmail, errors };
}

export async function approvalStatus(sha256: string) { return (await getIntake(sha256))?.ownerApproval ?? null; }
