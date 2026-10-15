// Learning loop for supplier-invoice coding. Nothing posts without a class;
// the owner assigns classes in the review queue and presses Post, and every
// such decision teaches the resolver. Three parts, all in the finance store:
//   CODING_DECISION#<sha256>#<timestamp>  every human / agent / autopilot
//       decision on an intake item: what the resolver proposed, what was
//       finally posted, what changed, and the invoice tokens that pointed at
//       the final class. Read-only history for the owner and the coding agent.
//   SUPPLIER#<vendorId>.classHints + CLASS_HINT#<token>  class rules learned
//       from those decisions (token on the invoice → QuickBooks class), used by
//       resolveClass() at 0.95 while the project is open.
//   CONFIG#intake-autopilot  the owner's switch: manual | assisted | full.
// Promotion / demotion of profile.autoPost follows the decisions; the autopilot
// mode itself is only ever changed by the owner (UI / set_intake_autopilot).
// Pure functions (autopilotDecision, deriveClassTokens, promotionDue, shapes)
// have no I/O and are unit-tested.
import { all } from "@/lib/core/store";
import { FinanceError } from "@/lib/core/domain";
import { company, financeStore } from "@/lib/core/server";
import { normName } from "@/lib/core/text";
import { getSupplierProfile, upsertSupplierProfile, listSupplierProfiles, type SupplierProfile, type ClassHint } from "@/lib/finance/suppliers";
import type { ExtractedInvoice } from "./extractor";
import { normToken, type Resolution, type ResolveOverrides, type ProjectLike, type PoLike, type GlobalClassHint } from "./resolve";
import type { IntakeRecord } from "./intake";

// ------------------------------------------------------------------ types
export type DecisionAction = "post" | "hold" | "reject" | "reprocess" | "edit_posted" | "promote" | "demote";

export interface CodingShape { vendorId: string | null; classId: string | null; className: string | null; accounts: string[]; vatKinds: string[] }
export interface CodingChanged { vendor: boolean; class: boolean; account: boolean; vat: boolean }
export interface DecisionEvidence { invoiceTextTokens: string[]; senderDomain: string | null; fileName: string | null }

export interface CodingDecision {
  sha256: string;
  vendorId: string | null;
  vendorName: string | null;
  docNumber: string | null;
  action: DecisionAction;
  by: string;
  at: string;
  autopilot: boolean;              // by === "autopilot"
  dryRun: boolean;                 // posting was off: decision recorded, QuickBooks untouched
  confidence: number;              // resolver confidence at decision time
  proposed: CodingShape;
  final: CodingShape;
  changed: CodingChanged;
  evidence: DecisionEvidence;
  note: string | null;
}

export type AutopilotMode = "manual" | "assisted" | "full";
export interface AutopilotConfig {
  mode: AutopilotMode;
  minConfidence: number;
  requireClass: boolean;
  requireKnownVendor: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}
export const DEFAULT_AUTOPILOT: AutopilotConfig = { mode: "manual", minConfidence: 0.9, requireClass: true, requireKnownVendor: true, updatedBy: null, updatedAt: null };
export const AUTOPILOT_ACTOR = "autopilot";
export const PROMOTION_STREAK = 3;

const KEY = {
  decision: (sha: string, at: string) => `CODING_DECISION#${sha}#${at}`,
  hint: (token: string) => `CLASS_HINT#${normToken(token)}`,
  autopilot: "CONFIG#intake-autopilot",
};
const now = () => new Date().toISOString();

// ------------------------------------------------------------ pure: shapes
const EMPTY_SHAPE: CodingShape = { vendorId: null, classId: null, className: null, accounts: [], vatKinds: [] };

export function codingShape(r: Resolution | null | undefined): CodingShape {
  if (!r) return { ...EMPTY_SHAPE };
  // One class for the bill when every line agrees; otherwise the header class.
  const lineClasses = Array.from(new Set(r.lines.map((l) => l.classId).filter((x): x is string => !!x)));
  const classId = lineClasses.length === 1 ? lineClasses[0] : r.classId;
  const className = lineClasses.length === 1 ? (r.lines.find((l) => l.classId === classId)?.className || r.className) : r.className;
  return {
    vendorId: r.vendorId ?? null,
    classId: classId ?? null,
    className: className ?? null,
    accounts: r.lines.map((l) => l.accountName || l.accountId || "").filter(Boolean),
    vatKinds: r.lines.map((l) => l.vatKind || l.taxCodeId || "").filter(Boolean),
  };
}

export function diffShapes(proposed: CodingShape, final: CodingShape): CodingChanged {
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  return {
    vendor: (proposed.vendorId || null) !== (final.vendorId || null),
    class: (proposed.classId || null) !== (final.classId || null),
    account: !same(proposed.accounts, final.accounts),
    vat: !same(proposed.vatKinds, final.vatKinds),
  };
}

// ------------------------------------------------------- pure: class tokens
export interface ClassToken { token: string; kind: "surname" | "postcode" | "po"; scope: "vendor" | "global"; projectId: string | null }

// Text on the invoice that can carry a project pointer: references and line
// text — never the supplier's own identity or the document number.
function projectText(x: ExtractedInvoice): string {
  return [x.projectReference, x.poReference, ...x.lines.flatMap((l) => [l.description, l.useContext])].filter(Boolean).join(" \n ");
}

// Which project the final class belongs to: the resolver's projectId, else the
// project whose customer name is the class name (classes are customer names).
export function projectForClass(final: { classId: string | null; className: string | null; projectId?: string | null }, projects: ProjectLike[]): ProjectLike | null {
  if (final.projectId) { const p = projects.find((x) => x.id === final.projectId); if (p) return p; }
  const cn = normName(final.className || "");
  if (!cn) return null;
  const exact = projects.filter((p) => normName(p.name) === cn);
  if (exact.length === 1) return exact[0];
  const parts = cn.split(" ").filter((p) => p.length > 2);
  if (parts.length < 2) return null;
  const loose = projects.filter((p) => { const pn = normName(p.name); return parts.every((part) => pn.includes(part)); });
  return loose.length === 1 ? loose[0] : null;
}

// The strongest invoice tokens that point at the chosen class: the client's
// surname, the site postcode and CRM purchase-order references for that
// project. Postcode and PO refs are project-specific → global; a short surname
// stays on the vendor profile only.
export function deriveClassTokens(x: ExtractedInvoice, final: { classId: string | null; className: string | null; projectId?: string | null }, ctx: { projects: ProjectLike[]; orders: PoLike[] }): ClassToken[] {
  if (!final.classId) return [];
  const project = projectForClass(final, ctx.projects);
  const raw = projectText(x);
  const nameNorm = ` ${normName(raw)} `;
  const tokNorm = ` ${normToken(raw)} `;
  const compact = tokNorm.replace(/\s+/g, "");
  const appears = (t: string) => { const n = normToken(t); if (n.length < 3) return false; return tokNorm.includes(` ${n} `) || nameNorm.includes(` ${n} `) || (/\d/.test(n) && compact.includes(n.replace(/\s+/g, ""))); };
  const out: ClassToken[] = [];
  const push = (t: ClassToken) => { if (!out.some((o) => o.token === t.token)) out.push(t); };
  const projectId = project?.id ?? final.projectId ?? null;
  if (project) {
    const surname = normName(project.lastName);
    if (surname.length >= 3 && appears(surname)) push({ token: surname, kind: "surname", scope: surname.length >= 4 ? "global" : "vendor", projectId });
    const pc = normToken(project.postcode || "");
    if (pc.length >= 5 && appears(pc)) push({ token: pc, kind: "postcode", scope: "global", projectId });
  }
  for (const po of ctx.orders) {
    if (!po.reference || (projectId && po.projectId !== projectId)) continue;
    if (!projectId && normName(po.projectName) !== normName(final.className || "")) continue;
    const ref = normToken(po.reference);
    if (ref.length >= 4 && (appears(ref) || normToken(x.poReference || "") === ref)) push({ token: ref, kind: "po", scope: "global", projectId: po.projectId });
  }
  return out;
}

// -------------------------------------------------------- pure: autopilot
export interface AutopilotItem {
  state: string;
  confidence: number;
  reasons: string[];
  vendorId: string | null;
  vendorScore?: number;
  classId: string | null;
  ownerApproved?: boolean;         // owner replied APPROVE for a new supplier
  profile: Pick<SupplierProfile, "autoPost" | "onHold"> | null;
}
export interface AutopilotVerdict { post: boolean; reason: string; mode: AutopilotMode; overrides?: ResolveOverrides }

// The one place that decides whether intake may post without a human. The
// posting switch (cfg.quickbooks.postBills) stays the hard master switch; the
// mode never bypasses it.
export function autopilotDecision(cfg: AutopilotConfig, item: AutopilotItem, posting: boolean): AutopilotVerdict {
  const no = (reason: string): AutopilotVerdict => ({ post: false, reason, mode: cfg.mode });
  if (!posting) return no("QuickBooks posting is off (quickbooks.postBills)");
  if (cfg.mode === "manual") return no("autopilot is manual: everything waits for a human");
  if (item.state !== "proposed") return no(`state is ${item.state}`);
  if (item.profile?.onHold) return no("supplier is on hold");
  if (!item.vendorId) {
    if (cfg.requireKnownVendor) return no("vendor not in QuickBooks (requireKnownVendor)");
    if (!item.ownerApproved) return no("new supplier needs the owner's APPROVE");
  }
  const otherReasons = item.reasons.filter((r) => !/^(CLASS_UNRESOLVED|TERMS_MISSING)\b/.test(r));
  let overrides: ResolveOverrides | undefined;
  let confidence = item.confidence;
  if (!item.classId) {
    if (cfg.requireClass) return no("no class resolved (requireClass)");
    if (otherReasons.length) return no(`unresolved: ${otherReasons.join(", ")}`);
    // Overhead bill allowed without a class: confidence is then the vendor match.
    overrides = { allowNoClass: true };
    confidence = item.vendorScore ?? item.confidence;
  }
  if (confidence < cfg.minConfidence) return no(`confidence ${confidence} below ${cfg.minConfidence}`);
  if (otherReasons.length && item.classId) return no(`unresolved: ${otherReasons.join(", ")}`);
  if (cfg.mode === "assisted") {
    if (!item.profile?.autoPost) return no("assisted mode: supplier is not on auto-post");
    return { post: true, reason: "assisted: supplier on auto-post, coding certain", mode: cfg.mode, overrides };
  }
  return { post: true, reason: "full: coding certain", mode: cfg.mode, overrides };
}

// Three consecutive agreeing posts for a vendor (latest first) earn auto-post.
export function promotionDue(decisions: CodingDecision[], streak = PROMOTION_STREAK): boolean {
  const posts = decisions.filter((d) => d.action === "post").sort((a, b) => b.at.localeCompare(a.at)).slice(0, streak);
  if (posts.length < streak) return false;
  return posts.every((d) => !d.changed.class && !d.changed.account && !d.changed.vendor);
}

export function normaliseAutopilotPatch(patch: Partial<Pick<AutopilotConfig, "mode" | "minConfidence" | "requireClass" | "requireKnownVendor">>): Partial<AutopilotConfig> {
  const out: Partial<AutopilotConfig> = {};
  if (patch.mode !== undefined) {
    if (!["manual", "assisted", "full"].includes(patch.mode)) throw new FinanceError("AUTOPILOT_MODE_INVALID", false, 422);
    out.mode = patch.mode;
  }
  if (patch.minConfidence !== undefined) {
    const n = Number(patch.minConfidence);
    if (!Number.isFinite(n) || n < 0.5 || n > 1) throw new FinanceError("AUTOPILOT_MIN_CONFIDENCE_INVALID: 0.5–1", false, 422);
    out.minConfidence = Math.round(n * 100) / 100;
  }
  if (patch.requireClass !== undefined) out.requireClass = !!patch.requireClass;
  if (patch.requireKnownVendor !== undefined) out.requireKnownVendor = !!patch.requireKnownVendor;
  return out;
}

// ------------------------------------------------------------ autopilot I/O
export async function getAutopilot(): Promise<AutopilotConfig> {
  const row = await financeStore().get<Partial<AutopilotConfig>>(company(), KEY.autopilot);
  return { ...DEFAULT_AUTOPILOT, ...(row?.data || {}) };
}

export async function setAutopilot(patch: Partial<Pick<AutopilotConfig, "mode" | "minConfidence" | "requireClass" | "requireKnownVendor">>, by: string): Promise<AutopilotConfig> {
  const store = financeStore(); const c = company();
  const row = await store.get<Partial<AutopilotConfig>>(c, KEY.autopilot);
  const next: AutopilotConfig = { ...DEFAULT_AUTOPILOT, ...(row?.data || {}), ...normaliseAutopilotPatch(patch), updatedBy: by, updatedAt: now() };
  await store.transact(c, [{ key: KEY.autopilot, expected: row?.version ?? null, data: next }]);
  return next;
}

// ------------------------------------------------------------ decisions I/O
export interface RecordDecisionInput {
  record: IntakeRecord;                 // the record AFTER the action
  action: DecisionAction;
  by: string;
  proposed: Resolution | null;          // what the resolver had on the record before the action
  final: Resolution | null;             // what was posted / kept
  dryRun?: boolean;
  note?: string | null;
  ctx?: { projects?: ProjectLike[]; orders?: PoLike[]; autopilot?: AutopilotConfig };
}

export async function recordDecision(input: RecordDecisionInput): Promise<CodingDecision> {
  const store = financeStore(); const c = company();
  const rec = input.record;
  const proposed = codingShape(input.proposed);
  const final = codingShape(input.final);
  const changed = diffShapes(proposed, final);
  const finalRes = input.final;
  const tokens = rec.extraction && finalRes ? deriveClassTokens(rec.extraction, { classId: final.classId, className: final.className, projectId: finalRes.projectId }, { projects: input.ctx?.projects || [], orders: input.ctx?.orders || [] }) : [];
  const arrival = rec.arrivals[rec.arrivals.length - 1];
  const at = now();
  const decision: CodingDecision = {
    sha256: rec.sha256,
    vendorId: final.vendorId ?? proposed.vendorId ?? null,
    vendorName: finalRes?.vendorName ?? input.proposed?.vendorName ?? rec.extraction?.supplierIdentity ?? null,
    docNumber: finalRes?.docNumber || input.proposed?.docNumber || rec.extraction?.documentNumber || null,
    action: input.action, by: input.by, at,
    autopilot: input.by === AUTOPILOT_ACTOR,
    dryRun: !!input.dryRun,
    confidence: rec.confidence,
    proposed, final, changed,
    evidence: { invoiceTextTokens: tokens.map((t) => t.token), senderDomain: (arrival?.from || "").toLowerCase().split("@")[1] || null, fileName: arrival?.fileName || null },
    note: input.note ?? null,
  };
  await store.transact(c, [{ key: KEY.decision(rec.sha256, at), expected: null, data: decision }]);

  // Learn from posts and post-edits by humans; autopilot only confirms.
  if ((input.action === "post" || input.action === "edit_posted") && finalRes) {
    const human = !decision.autopilot;
    if (human && (changed.class || !input.proposed?.classId) && final.classId && decision.vendorId) {
      await learnClassHints(decision.vendorId, finalRes.vendorName || decision.vendorName || decision.vendorId, tokens, { classId: final.classId, className: final.className || final.classId }, input.by).catch(() => {});
    } else if (final.classId && decision.vendorId) {
      await bumpClassHints(decision.vendorId, rec.extraction, final.classId).catch(() => {});
    }
    if (decision.vendorId) await reviewAutoPost(decision, input.ctx?.autopilot).catch(() => {});
  }
  return decision;
}

export async function listDecisions(filter: { vendorId?: string | null; vendor?: string | null; sha256?: string | null; since?: string | null; action?: DecisionAction | null; limit?: number } = {}): Promise<CodingDecision[]> {
  const prefix = filter.sha256 ? `CODING_DECISION#${filter.sha256}#` : "CODING_DECISION#";
  const rows = await all<CodingDecision>(financeStore(), company(), prefix);
  const vendor = (filter.vendor || "").toLowerCase();
  const since = filter.since ? Date.parse(filter.since) : NaN;
  if (filter.since && Number.isNaN(since)) throw new FinanceError("SINCE_INVALID", false, 422);
  return rows.map((r) => r.data).filter((d) => d && typeof d.sha256 === "string" && typeof d.at === "string")
    .filter((d) => !filter.vendorId || d.vendorId === filter.vendorId)
    .filter((d) => !vendor || (d.vendorName || "").toLowerCase().includes(vendor))
    .filter((d) => !filter.action || d.action === filter.action)
    .filter((d) => !filter.since || Date.parse(d.at) >= since)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, Math.max(1, Math.min(filter.limit ?? 200, 2000)));
}

export interface AgreementStats { decisions: number; proposals: number; posted: number; autoPosted: number; held: number; rejected: number; edited: number; classAgreement: number | null; accountAgreement: number | null; vatAgreement: number | null; avgConfidence: number | null }
export interface VendorStats extends AgreementStats { vendorId: string; vendorName: string | null; autoPost: boolean; lastDecisionAt: string | null }
export interface DecisionStats { since: string | null; overall: AgreementStats; vendors: VendorStats[]; last: CodingDecision[]; autopilot: AutopilotConfig; suppliersOnAutoPost: number; suppliers: number }

export function aggregateDecisions(ds: CodingDecision[]): AgreementStats {
  const coded = ds.filter((d) => d.action === "post" || d.action === "edit_posted");
  const rate = (pick: (d: CodingDecision) => boolean) => (coded.length ? Math.round((coded.filter(pick).length / coded.length) * 1000) / 1000 : null);
  const conf = ds.filter((d) => ["post", "hold", "reject"].includes(d.action));
  return {
    decisions: ds.length,
    proposals: ds.filter((d) => ["post", "hold", "reject", "edit_posted"].includes(d.action)).length,
    posted: ds.filter((d) => d.action === "post").length,
    autoPosted: ds.filter((d) => d.action === "post" && d.autopilot).length,
    held: ds.filter((d) => d.action === "hold").length,
    rejected: ds.filter((d) => d.action === "reject").length,
    edited: ds.filter((d) => d.action === "edit_posted").length,
    classAgreement: rate((d) => !d.changed.class),
    accountAgreement: rate((d) => !d.changed.account),
    vatAgreement: rate((d) => !d.changed.vat),
    avgConfidence: conf.length ? Math.round((conf.reduce((s, d) => s + (d.confidence || 0), 0) / conf.length) * 100) / 100 : null,
  };
}

export async function decisionStats(opts: { since?: string | null } = {}): Promise<DecisionStats> {
  const [ds, autopilot, profiles] = await Promise.all([listDecisions({ since: opts.since, limit: 2000 }), getAutopilot(), listSupplierProfiles().catch(() => [] as SupplierProfile[])]);
  const byVendor = new Map<string, CodingDecision[]>();
  for (const d of ds) { if (!d.vendorId) continue; const arr = byVendor.get(d.vendorId) || []; arr.push(d); byVendor.set(d.vendorId, arr); }
  const vendors: VendorStats[] = [...byVendor.entries()].map(([vendorId, list]) => ({
    vendorId, vendorName: list[0].vendorName, autoPost: !!profiles.find((p) => p.vendorId === vendorId)?.autoPost,
    lastDecisionAt: list[0].at, ...aggregateDecisions(list),
  })).sort((a, b) => b.decisions - a.decisions);
  return { since: opts.since || null, overall: aggregateDecisions(ds), vendors, last: ds.slice(0, 10), autopilot, suppliersOnAutoPost: profiles.filter((p) => p.autoPost).length, suppliers: profiles.length };
}

// ------------------------------------------------------------- hints I/O
export async function listGlobalClassHints(): Promise<GlobalClassHint[]> {
  const rows = await all<GlobalClassHint>(financeStore(), company(), "CLASS_HINT#");
  return rows.map((r) => r.data).filter((h) => h && typeof h.token === "string" && typeof h.classId === "string");
}

// Store the tokens on the vendor profile (all of them) and globally (project
// tokens). A token already pointing at a different class is a contradiction:
// the human's latest decision wins on the profile; globally the newer project
// replaces the older one.
export async function learnClassHints(vendorId: string, vendorName: string, tokens: ClassToken[], cls: { classId: string; className: string }, by: string): Promise<{ vendorHints: string[]; globalHints: string[] }> {
  const result = { vendorHints: [] as string[], globalHints: [] as string[] };
  if (!tokens.length) return result;
  const at = now();
  const profile = await getSupplierProfile(vendorId);
  const hints: Record<string, ClassHint> = { ...(profile?.classHints || {}) };
  for (const t of tokens) {
    const prev = hints[t.token];
    hints[t.token] = { classId: cls.classId, className: cls.className, projectId: t.projectId, hits: prev && prev.classId === cls.classId ? prev.hits + 1 : 1, lastSeen: at };
    result.vendorHints.push(t.token);
  }
  // Keep the profile small: most recent 40 hints.
  const trimmed = Object.fromEntries(Object.entries(hints).sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen)).slice(0, 40));
  await upsertSupplierProfile(vendorId, { vendorName: profile?.vendorName || vendorName, classHints: trimmed }, by);

  const store = financeStore(); const c = company();
  for (const t of tokens.filter((x) => x.scope === "global")) {
    const key = KEY.hint(t.token);
    const row = await store.get<GlobalClassHint>(c, key);
    const prev = row?.data;
    const same = prev && prev.classId === cls.classId;
    const data: GlobalClassHint = { token: normToken(t.token), classId: cls.classId, className: cls.className, projectId: t.projectId, hits: same ? (prev.hits || 0) + 1 : 1, lastSeen: at, vendorIds: Array.from(new Set([...(same ? prev.vendorIds || [] : []), vendorId])) };
    await store.transact(c, [{ key, expected: row?.version ?? null, data }]).catch(() => {});
    result.globalHints.push(t.token);
  }
  return result;
}

// An agreeing post strengthens the hints that fired for it.
async function bumpClassHints(vendorId: string, x: ExtractedInvoice | null, classId: string): Promise<void> {
  if (!x) return;
  const profile = await getSupplierProfile(vendorId);
  const hints = profile?.classHints || {};
  const fired = Object.entries(hints).filter(([token, h]) => h.classId === classId && tokenInText(token, x));
  if (!fired.length) return;
  const at = now();
  const next = { ...hints };
  for (const [token, h] of fired) next[token] = { ...h, hits: (h.hits || 0) + 1, lastSeen: at };
  await upsertSupplierProfile(vendorId, { classHints: next }, "intake-learning");
}
function tokenInText(token: string, x: ExtractedInvoice): boolean {
  const t = normToken(token); if (t.length < 3) return false;
  const text = ` ${normToken(projectText(x))} `;
  return text.includes(` ${t} `) || ` ${normName(projectText(x))} `.includes(` ${t} `) || (/\d/.test(t) && text.replace(/\s+/g, "").includes(t.replace(/\s+/g, "")));
}

// ------------------------------------------------- promotion / demotion
// Human override of class or account → demote (autoPost off). Three agreeing
// posts in a row → promote, but only while the owner's switch is assisted/full.
async function reviewAutoPost(decision: CodingDecision, cfgIn?: AutopilotConfig): Promise<void> {
  const vendorId = decision.vendorId!;
  const profile = await getSupplierProfile(vendorId);
  const cfg = cfgIn || await getAutopilot();
  const overridden = !decision.autopilot && (decision.changed.class || decision.changed.account);
  if (overridden && profile?.autoPost) {
    await upsertSupplierProfile(vendorId, { autoPost: false }, "intake-learning");
    await writeMeta(decision, "demote", `class/account overridden by ${decision.by}: autoPost → false`);
    return;
  }
  if (overridden || profile?.autoPost || cfg.mode === "manual") return;
  const recent = await listDecisions({ vendorId, action: "post", limit: PROMOTION_STREAK });
  if (!promotionDue(recent)) return;
  await upsertSupplierProfile(vendorId, { vendorName: profile?.vendorName || decision.vendorName || vendorId, autoPost: true }, "intake-learning");
  await writeMeta(decision, "promote", `${PROMOTION_STREAK} consecutive agreeing posts (mode ${cfg.mode}): autoPost → true`);
}

async function writeMeta(base: CodingDecision, action: "promote" | "demote", note: string): Promise<void> {
  const at = new Date(Date.parse(base.at) + 1).toISOString(); // strictly after the triggering decision
  const d: CodingDecision = { ...base, action, by: "intake-learning", at, autopilot: false, dryRun: false, proposed: base.final, final: base.final, changed: { vendor: false, class: false, account: false, vat: false }, evidence: { ...base.evidence, invoiceTextTokens: [] }, note };
  await financeStore().transact(company(), [{ key: KEY.decision(base.sha256, at), expected: null, data: d }]);
}
