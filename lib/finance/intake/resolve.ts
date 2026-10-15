// Deterministic coding of an extracted supplier invoice. No model picks ids:
// every vendor / class / account / tax code comes from QuickBooks reference
// data, the supplier profile, CRM purchase orders or the vendor's own bill
// history, and every shortfall is named in `reasons` so a human (or the coding
// agent) can see exactly why a bill was not auto-posted. Pure: no I/O.
import type { ExtractedInvoice } from "./extractor";
import { accountByName, classByCustomer, classByCustomerFuzzy, termById, vatKindFor, vendorByName, type QboRefData, type QboVendorRef, type TaxCodeConfig, type VatKind } from "@/lib/qbo/client";
import { dueFor, type TermSpec } from "@/lib/finance/terms";
import type { ClassHint, SupplierProfile } from "@/lib/finance/suppliers";
import { normName } from "@/lib/core/text";

// ------------------------------------------------------------------ types
export type IntakeReason =
  | "VENDOR_UNKNOWN" | "CLASS_UNRESOLVED" | "ACCOUNT_UNRESOLVED" | "VAT_CODE_UNRESOLVED"
  | "TERMS_MISSING" | "TOTALS_MISMATCH" | "DOCUMENT_OCR_REQUIRED" | "DATE_AMBIGUOUS"
  | "DOC_NUMBER_MISSING" | "MULTIPLE_DOCUMENTS" | "CURRENCY_NOT_GBP" | "NO_LINES" | "OWN_DOCUMENT_SUSPECTED";

// A CRM purchase order: the reference suppliers quote, the project it belongs to.
export interface PoLike { id?: string; reference: string; projectId: string; projectName: string; orderType?: "contract" | "addon" | "remedial" | null; supplierName?: string }
export interface ProjectLike { id: string; name: string; lastName: string; postcode?: string | null }
// What the class-hint guard needs to know about a project: is it still open?
// Completed = final sign-off dated; closed = cancelled or lost.
export interface ProjectStatusLike { id: string; status?: string | null; completedAt?: string | null; closedAt?: string | null }
// A learned token → class rule that applies to every vendor (project-specific
// tokens: postcode, PO reference, client surname). Stored as CLASS_HINT#<token>.
export interface GlobalClassHint extends ClassHint { token: string; vendorIds?: string[] }
export interface HistoryBill { classId: string | null; className: string | null; accountId: string | null; accountName: string | null }

export interface ResolveOverrides {
  vendorId?: string | null;
  docNumber?: string | null;
  txnDate?: string | null;
  dueDate?: string | null;
  classId?: string | null;             // applies to every line unless a line override says otherwise
  allowNoClass?: boolean;              // overhead bills: post without a class
  lines?: { accountId?: string | null; classId?: string | null; taxCodeId?: string | null; amount?: number | null; description?: string | null }[];
}

export interface ResolveContext {
  ref: QboRefData;
  taxCodes: TaxCodeConfig;
  profile: SupplierProfile | null;
  senderDomain: string | null;
  senderEmail?: string | null;
  orders: PoLike[];
  projects: ProjectLike[];
  vendorHistory: HistoryBill[];
  receivedAt: string;                  // ISO date-time the email arrived
  overrides?: ResolveOverrides;
  // Every supplier profile (vendorName + aliases) so a trading name / alias on
  // the PDF can resolve the vendor even when the sender domain is unknown.
  profiles?: Pick<SupplierProfile, "vendorId" | "vendorName" | "aliases">[];
  // Learned class rules (learning.ts): the vendor's own profile.classHints plus
  // the global CLASS_HINT# records, guarded by the project's status.
  globalClassHints?: GlobalClassHint[];
  projectStatus?: Record<string, ProjectStatusLike>;
  // Our own domains: an internal forward never identifies the vendor by sender domain.
  internalDomains?: string[];
  now?: string;                        // ISO date-time used by the project-open guard (tests)
}

export interface ResolvedLine {
  description: string;
  amount: number;                      // net (Bill is TaxExcluded)
  vat: number;
  accountId: string | null;
  accountName: string | null;
  classId: string | null;
  className: string | null;
  taxCodeId: string | null;
  vatKind: VatKind | null;
  accountSource: "override" | "hint" | "order_type" | "profile" | "family" | "default" | "unresolved";
}

export interface ClassCandidate { classId: string; className: string; source: "override" | "learned" | "po" | "project" | "history" | "fuzzy"; projectId?: string | null; poReference?: string | null; token?: string | null }

export interface Resolution {
  vendorId: string | null;
  vendorName: string | null;
  vendorScore: number;
  vendorSource: "override" | "profile" | "domain" | "alias" | "name" | "none";
  vendorProposed?: { displayName: string; email: string | null };
  docNumber: string;
  txnDate: string | null;
  dateNote: string | null;
  lines: ResolvedLine[];
  classId: string | null;
  className: string | null;
  classScore: number;
  classCandidates: ClassCandidate[];
  projectId: string | null;
  matchedPo: { reference: string; projectId: string; projectName: string; orderType: string } | null;
  dueDate: string | null;
  termName: string | null;
  totals: { net: number; vat: number; gross: number; linesNet: number };
  currency: string;
}

export interface ResolveResult { resolution: Resolution; reasons: IntakeReason[]; confidence: number }

// --------------------------------------------------------- item families
// Account names as they appear in a kitchen / interiors retailer's chart of
// accounts. Checked in order; remedial / additional first because they override
// the item itself. Rename to match your own chart (accountByName matches on name).
export const ITEM_FAMILY_TABLE: { account: string; pattern: RegExp }[] = [
  { account: "Remedials", pattern: /\b(remedial|remedials|replacement|replacements|damage|damaged|re-?supply|warranty)\b/i },
  { account: "Additionals", pattern: /\b(additional|additionals|extra|extras|add-?on)\b/i },
  { account: "Appliances", pattern: /\b(appliance|appliances|oven|ovens|hob|hobs|fridge|freezer|dishwasher|extractor|hood|microwave|cooker|wine cooler|washing machine|tumble dryer|warming drawer)\b/i },
  { account: "Worktops", pattern: /\b(worktop|worktops|quartz|granite|marble|dekton|silestone|laminate top|laminate tops)\b/i },
  { account: "Sink and Taps", pattern: /\b(sink|sinks|tap|taps|mixer tap|boiling water tap|waste disposer)\b/i },
  { account: "Tiles", pattern: /\b(tile|tiles|tiling)\b/i },
  { account: "Delivery and Removals", pattern: /\b(delivery|deliveries|carriage|freight|removal|removals|haulage|shipping)\b/i },
  { account: "Installation", pattern: /\b(install|installation|fitting|fitter|fitters|labour)\b/i },
  { account: "Purchase Accessories", pattern: /\b(handle|handles|hinge|hinges|drawer|drawers|runner|runners|accessory|accessories|plinth|lighting|led)\b/i },
];
export const DEFAULT_ACCOUNT = "Products and Units";

export function itemFamilyAccount(text: string): { account: string; matched: boolean } {
  for (const row of ITEM_FAMILY_TABLE) if (row.pattern.test(text)) return { account: row.account, matched: true };
  return { account: DEFAULT_ACCOUNT, matched: false };
}

// Which account name a line should be coded to, before mapping to an id.
export function accountNameFor(line: { description: string; itemFamily?: string | null; useContext?: string | null }, ctx: { profile: SupplierProfile | null; orderType?: string | null }): { name: string; source: ResolvedLine["accountSource"] } {
  const text = [line.description, line.itemFamily, line.useContext].filter(Boolean).join(" ");
  const hints = ctx.profile?.categoryHints || {};
  for (const [keyword, account] of Object.entries(hints)) {
    if (keyword && account && new RegExp(`\\b${escapeRe(keyword)}`, "i").test(text)) return { name: account, source: "hint" };
  }
  if (ctx.orderType === "remedial") return { name: "Remedials", source: "order_type" };
  if (ctx.orderType === "addon") return { name: "Additionals", source: "order_type" };
  const family = itemFamilyAccount(text);
  // A specific family beats the supplier default; the generic default does not.
  if (family.matched && family.account !== DEFAULT_ACCOUNT && ctx.profile?.defaultAccountName !== DEFAULT_ACCOUNT) return { name: family.account, source: "family" };
  if (ctx.profile?.defaultAccountName) return { name: ctx.profile.defaultAccountName, source: "profile" };
  return family.matched ? { name: family.account, source: "family" } : { name: DEFAULT_ACCOUNT, source: "default" };
}

// ------------------------------------------------------------- vendor
export function scoreVendor(supplierIdentity: string, ctx: Pick<ResolveContext, "ref" | "profile" | "senderDomain" | "overrides" | "profiles" | "internalDomains">): { vendor: QboVendorRef | null; score: number; source: Resolution["vendorSource"] } {
  const byId = (id: string | null | undefined) => (id ? ctx.ref.vendors.find((v) => v.id === id) || null : null);
  const o = byId(ctx.overrides?.vendorId);
  if (o) return { vendor: o, score: 1, source: "override" };
  // Profile found by sender domain / alias and pointing at a real vendor.
  const p = byId(ctx.profile?.vendorId);
  if (p) return { vendor: p, score: 1, source: "profile" };
  // Vendor record carries the sender's domain (never a webmail or our own domain).
  const domain = (ctx.senderDomain || "").toLowerCase();
  if (domain && !GENERIC_DOMAINS.has(domain) && !(ctx.internalDomains || []).map((d) => d.toLowerCase()).includes(domain)) {
    const hits = ctx.ref.vendors.filter((v) => (v.email || "").toLowerCase().split("@")[1] === domain);
    if (hits.length === 1) return { vendor: hits[0], score: 0.9, source: "domain" };
  }
  // Aliases / trading names known on any supplier profile: run the same matcher
  // over a pseudo vendor list where each alias stands in for its vendor.
  const aliasVendors: QboVendorRef[] = [];
  for (const prof of ctx.profiles || []) {
    const real = byId(prof.vendorId);
    if (!real) continue;
    for (const alias of [prof.vendorName, ...(prof.aliases || [])]) if (alias && alias.trim()) aliasVendors.push({ ...real, name: alias });
  }
  if (aliasVendors.length) {
    const a = vendorByName({ vendors: aliasVendors }, supplierIdentity);
    if (a.vendor && a.score >= 0.8) { const real = byId(a.vendor.id); if (real) return { vendor: real, score: Math.min(0.9, a.score), source: "alias" }; }
  }
  // Name on the invoice (and any aliases the profile knows).
  const names = [supplierIdentity, ctx.profile?.vendorName, ...(ctx.profile?.aliases || [])].filter((x): x is string => !!x);
  let best: { vendor: QboVendorRef | null; score: number } = { vendor: null, score: 0 };
  for (const n of names) { const r = vendorByName(ctx.ref, n); if (r.score > best.score) best = r; }
  return { ...best, source: best.vendor ? "name" : "none" };
}
const GENERIC_DOMAINS = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "live.com"]);

// ------------------------------------------------------- own documents
// Our own sales invoices / quotes get forwarded internally and must not become
// supplier bills. Identified by our company name or our VAT number appearing
// as the supplier. Pure: the company identity comes from config.
// Light normalisation only (legal suffixes and punctuation): the shared
// normName also drops trade words such as "kitchens", which would make
// "Acme Kitchens Ltd" match every supplier called Acme.
const ownNorm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(ltd|limited|plc|llp|inc|llc|gmbh)\b/g, " ").replace(/\s+/g, " ").trim();
export function isOwnDocument(x: Pick<ExtractedInvoice, "supplierIdentity">, own: { name?: string | null; vatNumber?: string | null }): boolean {
  const id = (x.supplierIdentity || "").toLowerCase().replace(/\s+/g, " ");
  const name = ownNorm(own.name || "");
  if (name.length >= 3 && ` ${ownNorm(id)} `.includes(` ${name} `)) return true;
  const vat = (own.vatNumber || "").replace(/\bgb\b/gi, "").replace(/[^0-9]/g, "");
  if (vat.length < 5) return false;
  // VAT numbers print as "GB 123 456 789" or "GB123456789": join digit groups
  // separated only by spaces, then look for our number as a whole token (so a
  // longer order number that merely contains the digits does not count).
  const digits = id.replace(/\bgb\b/g, " ").replace(/(\d)\s+(?=\d)/g, "$1").replace(/[^0-9]+/g, " ");
  return ` ${digits} `.includes(` ${vat} `);
}

// The extractor could not name a supplier at all ("unknown", blank, n/a).
export function supplierUnreadable(x: Pick<ExtractedInvoice, "supplierIdentity">): boolean {
  const id = (x.supplierIdentity || "").trim().toLowerCase();
  return !id || id === "unknown" || id === "n/a" || id === "none" || id === "not stated";
}

// Human-readable text for reasons the review queue shows as-is.
export function reasonText(reason: IntakeReason, x: Pick<ExtractedInvoice, "documentCount">): string {
  if (reason === "MULTIPLE_DOCUMENTS") return `MULTIPLE_DOCUMENTS: PDF contains ${x.documentCount} documents — split and re-send`;
  if (reason === "OWN_DOCUMENT_SUSPECTED") return "OWN_DOCUMENT_SUSPECTED: sent from an internal address and no supplier could be read — most likely one of our own sales invoices or quotes; reprocess if it really is a supplier bill";
  return reason;
}

// -------------------------------------------------------------- class
export function resolveClass(x: ExtractedInvoice, ctx: ResolveContext): { classId: string | null; className: string | null; score: number; candidates: ClassCandidate[]; projectId: string | null; matchedPo: Resolution["matchedPo"] } {
  const o = ctx.overrides?.classId;
  if (o) {
    const c = ctx.ref.classes.find((k) => k.id === o);
    return { classId: o, className: c?.name || o, score: 1, candidates: c ? [{ classId: c.id, className: c.name, source: "override" }] : [], projectId: null, matchedPo: null };
  }
  const text = invoiceText(x);
  const textNorm = ` ${normName(text)} `;
  const candidates: ClassCandidate[] = [];
  let matchedPo: Resolution["matchedPo"] = null;

  // 0. Learned hints: tokens a human has tied to a class before (vendor profile
  //    and global project tokens), while that project is still open. Exactly
  //    one class → 0.95; several → ambiguous, shown as candidates, held.
  const learned = matchLearnedClass(x, ctx);
  for (const l of learned) candidates.push(l);

  // 1. CRM purchase order reference or project name on the invoice → class named after the customer.
  for (const po of ctx.orders) {
    const refHit = po.reference && (text.toLowerCase().includes(po.reference.toLowerCase()) || (x.poReference && normName(x.poReference) === normName(po.reference)));
    const nameHit = po.projectName && nameAppears(po.projectName, textNorm);
    if (!refHit && !nameHit) continue;
    for (const c of classByCustomer(ctx.ref, po.projectName)) {
      if (!candidates.some((k) => k.classId === c.id)) candidates.push({ classId: c.id, className: c.name, source: "po", projectId: po.projectId, poReference: po.reference });
    }
    if (!matchedPo) matchedPo = { reference: po.reference, projectId: po.projectId, projectName: po.projectName, orderType: po.orderType || "contract" };
  }
  let score = 0;
  if (candidates.length === 1) score = 0.9;

  // 2. Client surname appears on the invoice (delivery address / customer field).
  if (!candidates.length) {
    for (const project of ctx.projects) {
      const ln = normName(project.lastName);
      if (ln.length < 3 || !textNorm.includes(` ${ln} `)) continue;
      for (const c of classByCustomer(ctx.ref, project.name)) {
        if (!candidates.some((k) => k.classId === c.id)) candidates.push({ classId: c.id, className: c.name, source: "project", projectId: project.id });
      }
    }
    if (candidates.length === 1) score = 0.8;
  }

  // 2b. Near-miss spelling between the CRM/PO name and the QuickBooks class.
  //     Suggested only: the score stays below every autopost threshold so a human picks it.
  let fuzzy = false;
  if (!candidates.length) {
    const names = new Map<string, string | null>();
    for (const po of ctx.orders) if (po.projectName && nameAppears(po.projectName, textNorm)) names.set(po.projectName, po.projectId);
    for (const project of ctx.projects) { const ln = normName(project.lastName); if (ln.length >= 3 && textNorm.includes(` ${ln} `)) names.set(project.name, project.id); }
    for (const [name, projectId] of names) {
      for (const c of classByCustomerFuzzy(ctx.ref, name)) {
        if (!candidates.some((k) => k.classId === c.id)) candidates.push({ classId: c.id, className: c.name, source: "fuzzy", projectId });
      }
    }
    if (candidates.length === 1) { score = 0.6; fuzzy = true; }
  }

  // 3. Vendor history: agreement lifts a candidate to 1.0; a single consistent class alone is 0.7.
  const historyClasses = new Map<string, string>();
  for (const h of ctx.vendorHistory) if (h.classId) historyClasses.set(h.classId, h.className || h.classId);
  if (candidates.length === 1 && historyClasses.has(candidates[0].classId)) score = 1;
  if (!candidates.length) {
    for (const [id, name] of historyClasses) candidates.push({ classId: id, className: name, source: "history" });
    if (historyClasses.size === 1) score = 0.7;
  }
  // Several classes from any mix of sources (two learned hints, or a learned
  // hint disagreeing with the PO) = ambiguous → hold for a human.
  if (candidates.length > 1) score = 0;
  else if (learned.length === 1) score = Math.max(score, 0.95);
  if (fuzzy) score = Math.min(score, 0.6);
  const pick = score > 0 ? candidates[0] : null;
  return { classId: pick?.classId ?? null, className: pick?.className ?? null, score, candidates: candidates.slice(0, 12), projectId: pick?.projectId ?? matchedPo?.projectId ?? null, matchedPo };
}

// --------------------------------------------------------- learned hints
const HINT_GRACE_DAYS = 60;

// A class hint only applies while the project is open: not completed, cancelled
// or lost more than 60 days before `now`. Unknown project (no status row) → open.
export function projectOpen(status: ProjectStatusLike | null | undefined, now: string | Date = new Date()): boolean {
  if (!status) return true;
  const nowMs = typeof now === "string" ? Date.parse(now) : now.getTime();
  const closedAt = status.completedAt || status.closedAt || null;
  const s = (status.status || "").toLowerCase();
  const closed = !!closedAt || s === "cancelled" || s === "lost" || s === "completed";
  if (!closed) return true;
  if (!closedAt) return false; // closed with no date → treat as long closed
  const ms = Date.parse(closedAt);
  if (Number.isNaN(ms)) return false;
  return nowMs - ms <= HINT_GRACE_DAYS * 86_400_000;
}

// Normalised token form shared by learning and matching: lower-case, spaces
// collapsed, punctuation dropped, nothing else (postcodes keep their digits).
export const normToken = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Does `token` appear as whole words in the invoice? Checked against the raw
// text (postcodes, PO refs) and the name-normalised text (surnames).
export function tokenAppears(token: string, x: ExtractedInvoice): boolean {
  const t = normToken(token);
  if (t.length < 3) return false;
  const haystacks = [` ${normToken(invoiceText(x))} `, ` ${normName(invoiceText(x))} `, ` ${normToken(x.poReference || "")} `, ` ${normToken(x.projectReference || "")} `];
  // Postcode / reference tokens are often printed without their internal space.
  const compact = t.replace(/\s+/g, "");
  return haystacks.some((h) => h.includes(` ${t} `)) || (compact !== t && haystacks.some((h) => h.replace(/\s+/g, "").includes(compact) && /\d/.test(compact)));
}

// Distinct classes the learned hints point at for this invoice (vendor
// profile first, then global). Hints for closed projects or classes no longer
// in QuickBooks are ignored. Returns one candidate per class.
export function matchLearnedClass(x: ExtractedInvoice, ctx: Pick<ResolveContext, "ref" | "profile" | "globalClassHints" | "projectStatus" | "now">): ClassCandidate[] {
  const out = new Map<string, ClassCandidate>();
  const now = ctx.now || new Date();
  const consider = (token: string, h: ClassHint) => {
    if (!h?.classId || out.has(h.classId)) return;
    if (!ctx.ref.classes.some((c) => c.id === h.classId)) return;
    if (h.projectId && !projectOpen(ctx.projectStatus?.[h.projectId], now)) return;
    if (!tokenAppears(token, x)) return;
    out.set(h.classId, { classId: h.classId, className: ctx.ref.classes.find((c) => c.id === h.classId)?.name || h.className, source: "learned", projectId: h.projectId ?? null, token });
  };
  for (const [token, h] of Object.entries(ctx.profile?.classHints || {})) consider(token, h);
  for (const g of ctx.globalClassHints || []) consider(g.token, g);
  return [...out.values()];
}

function nameAppears(fullName: string, textNorm: string): boolean {
  const parts = normName(fullName).split(" ").filter((p) => p.length > 2);
  if (!parts.length) return false;
  // Surname (last token) must appear; a first name alone is too weak.
  const last = parts[parts.length - 1];
  return textNorm.includes(` ${last} `) && (parts.length === 1 || parts.slice(0, -1).some((p) => textNorm.includes(` ${p} `)) || last.length >= 5);
}

export function invoiceText(x: ExtractedInvoice): string {
  return [x.supplierIdentity, x.documentNumber, x.projectReference, x.poReference, ...x.lines.flatMap((l) => [l.description, l.useContext, l.sku])].filter(Boolean).join(" \n ");
}

// --------------------------------------------------------------- dates
const money = (s: string | number | null | undefined) => { const n = typeof s === "number" ? s : parseFloat(String(s ?? "").replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };

// UK invoices are dd/mm/yyyy. Returns the ISO date and whether the day could
// have been a month (day ≤ 12) so the caller can sanity-check against receipt.
export function parseUkDate(text: string): { iso: string; swappable: boolean; swapped: string | null } | null {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return { iso: iso[0], swappable: false, swapped: null };
  const m = text.match(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/);
  if (m) {
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10); let y = parseInt(m[3], 10); if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const out = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const swapped = d <= 12 && d !== mo ? `${y}-${String(d).padStart(2, "0")}-${String(mo).padStart(2, "0")}` : null;
    return { iso: out, swappable: d <= 12, swapped };
  }
  const words = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/i);
  if (words) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const mo = months.indexOf(words[2].slice(0, 3).toLowerCase()) + 1;
    return { iso: `${words[3]}-${String(mo).padStart(2, "0")}-${String(parseInt(words[1], 10)).padStart(2, "0")}`, swappable: false, swapped: null };
  }
  return null;
}

export function dateSanity(txnDate: string, swappable: boolean, receivedAt: string): { ok: boolean; note: string | null } {
  const received = new Date(receivedAt);
  const d = new Date(txnDate + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return { ok: false, note: "unparseable date" };
  const days = Math.round((received.getTime() - d.getTime()) / 86_400_000);
  if (days < -1) return { ok: false, note: `invoice dated ${-days} days after the email arrived` };
  if (swappable && days > 45) return { ok: false, note: `day ≤ 12 and ${days} days before the email — dd/mm vs mm/dd needs a human check` };
  if (days > 400) return { ok: false, note: `invoice dated ${days} days before the email` };
  return { ok: true, note: null };
}

// --------------------------------------------------------------- terms
export function termSpecFor(ref: QboRefData, vendor: QboVendorRef | null, profile: SupplierProfile | null): { spec: TermSpec; name: string } | null {
  const t = termById(ref, vendor?.termId ?? null);
  if (t) {
    if (t.type === "DATE_DRIVEN" || /end of (the )?following month|eom/i.test(t.name)) return { spec: { name: t.name, kind: "eom_next", days: 0 }, name: t.name };
    if (t.dueDays != null) return { spec: { name: t.name, kind: "days", days: t.dueDays }, name: t.name };
  }
  if (profile?.terms) {
    const name = profile.terms.kind === "days" ? `Net ${profile.terms.days}` : "End of following month";
    return { spec: { name, kind: profile.terms.kind, days: profile.terms.days }, name: `${name} (profile)` };
  }
  if (profile?.statementAccount) return { spec: { name: "End of following month", kind: "eom_next", days: 0 }, name: "End of following month (statement account)" };
  return null;
}

// -------------------------------------------------------------- resolve
export function resolveInvoice(x: ExtractedInvoice, ctx: ResolveContext): ResolveResult {
  const reasons = new Set<IntakeReason>();
  const ov = ctx.overrides || {};

  // Vendor
  const v = scoreVendor(x.supplierIdentity, ctx);
  const vendor = v.score >= 0.8 ? v.vendor : null;
  if (!vendor) reasons.add("VENDOR_UNKNOWN");
  const vendorScore = vendor ? v.score : 0;

  // Document number
  const docNumber = (ov.docNumber ?? x.documentNumber ?? "").trim();
  if (!docNumber) reasons.add("DOC_NUMBER_MISSING");
  if (x.documentCount > 1) reasons.add("MULTIPLE_DOCUMENTS");
  if (x.currency !== "GBP") reasons.add("CURRENCY_NOT_GBP");

  // Date
  let txnDate: string | null = null, dateNote: string | null = null, dateOk = true;
  if (ov.txnDate) txnDate = ov.txnDate;
  else {
    const parsed = x.confirmedIsoDate ? { iso: x.confirmedIsoDate, swappable: parseInt(x.confirmedIsoDate.slice(8, 10), 10) <= 12, swapped: null } : parseUkDate(x.invoiceDateText || "");
    if (!parsed) { dateOk = false; dateNote = `no date recognised in "${(x.invoiceDateText || "").slice(0, 40)}"`; }
    else {
      txnDate = parsed.iso;
      const s = dateSanity(parsed.iso, parsed.swappable, ctx.receivedAt);
      if (!s.ok) { dateOk = false; dateNote = s.note; }
    }
  }
  if (!dateOk) reasons.add("DATE_AMBIGUOUS");

  // Class
  const cls = resolveClass(x, ctx);
  const classId = cls.classId;
  if (!classId && !ov.allowNoClass) reasons.add("CLASS_UNRESOLVED");
  const classScore = ov.allowNoClass && !classId ? 1 : cls.score;

  // Lines
  const totals = { net: money(x.net), vat: money(x.vat), gross: money(x.gross), linesNet: 0 };
  const srcLines = x.lines.length ? x.lines : [{ id: "1", description: `Invoice ${docNumber || ""}`.trim(), sku: null, itemFamily: "unknown", useContext: "unknown", net: x.net, vat: x.vat, gross: x.gross, vatEvidenceQuote: null }];
  const docVat = vatKindFor(totals.net, totals.vat, invoiceText(x));
  const lines: ResolvedLine[] = srcLines.map((l, i) => {
    const lo = ov.lines?.[i] || {};
    const net = lo.amount != null ? money(lo.amount) : money(l.net);
    const vat = money(l.vat);
    let accountId: string | null = null, accountName: string | null = null, accountSource: ResolvedLine["accountSource"] = "unresolved";
    if (lo.accountId) {
      const a = ctx.ref.accounts.find((k) => k.id === lo.accountId);
      accountId = lo.accountId; accountName = a?.name || lo.accountId; accountSource = "override";
    } else {
      const want = accountNameFor({ description: l.description, itemFamily: l.itemFamily, useContext: l.useContext }, { profile: ctx.profile, orderType: cls.matchedPo?.orderType || null });
      const a = accountByName(ctx.ref, want.name);
      accountName = want.name;
      if (a) { accountId = a.id; accountName = a.name; accountSource = want.source; }
    }
    if (!accountId) reasons.add("ACCOUNT_UNRESOLVED");
    const lineClassId = lo.classId !== undefined ? lo.classId : classId;
    const lineClass = lineClassId ? ctx.ref.classes.find((k) => k.id === lineClassId) : null;
    let taxCodeId: string | null = null, vatKind: VatKind | null = null;
    if (lo.taxCodeId) { taxCodeId = lo.taxCodeId; vatKind = (Object.entries(ctx.taxCodes).find(([k, v]) => v === lo.taxCodeId && k !== "names") || [null])[0] as VatKind | null; }
    else {
      vatKind = vatKindFor(net, vat, `${l.description} ${l.vatEvidenceQuote || ""}`) ?? (x.lines.length <= 1 ? docVat : null);
      taxCodeId = vatKind ? ctx.taxCodes[vatKind] : null;
    }
    if (!taxCodeId) reasons.add("VAT_CODE_UNRESOLVED");
    return { description: (lo.description ?? l.description ?? "").slice(0, 200), amount: net, vat, accountId, accountName, classId: lineClassId ?? null, className: lineClass?.name ?? (lineClassId ? cls.className : null), taxCodeId, vatKind, accountSource };
  });
  if (!lines.length) reasons.add("NO_LINES");
  totals.linesNet = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const totalsOk = Math.abs(totals.linesNet - totals.net) <= 0.02 && Math.abs(totals.net + totals.vat - totals.gross) <= 0.02 && totals.gross > 0;
  if (!totalsOk) reasons.add("TOTALS_MISMATCH");

  // Due date
  let dueDate: string | null = null, termName: string | null = null;
  if (ov.dueDate) { dueDate = ov.dueDate; termName = "override"; }
  else {
    const t = termSpecFor(ctx.ref, vendor, ctx.profile);
    if (t && txnDate) { dueDate = dueFor(txnDate, t.spec); termName = t.name; }
    else if (!t) reasons.add("TERMS_MISSING");
  }

  const vatOk = lines.every((l) => l.taxCodeId);
  const accountsOk = lines.every((l) => l.accountId);
  let confidence = Math.min(vendorScore, classScore, vatOk ? 1 : 0, accountsOk ? 1 : 0, totalsOk ? 1 : 0, dateOk ? 1 : 0, docNumber ? 1 : 0, x.documentCount > 1 ? 0 : 1, x.currency === "GBP" ? 1 : 0);
  if (reasons.has("TERMS_MISSING")) confidence = Math.min(confidence, 0.8);
  confidence = Math.round(confidence * 100) / 100;

  const resolution: Resolution = {
    vendorId: vendor?.id ?? null, vendorName: vendor?.name ?? null, vendorScore, vendorSource: vendor ? v.source : "none",
    ...(vendor ? {} : { vendorProposed: { displayName: (x.supplierIdentity || "").trim().slice(0, 100) || "Unknown supplier", email: ctx.senderEmail || null } }),
    docNumber, txnDate, dateNote,
    lines, classId, className: cls.className, classScore, classCandidates: cls.candidates, projectId: cls.projectId, matchedPo: cls.matchedPo,
    dueDate, termName, totals, currency: x.currency,
  };
  return { resolution, reasons: [...reasons], confidence };
}

function escapeRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
