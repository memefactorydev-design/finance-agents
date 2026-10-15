// QuickBooks Online client: token source (own OAuth app or Composio), reads
// (query, reports, entities), the batch endpoint and the few writes the
// finance system makes (Vendor, Bill + attachment, Bill update). Every write
// passes through writeGate(): with posting off nothing is created — the exact
// payload is returned as a dry run so the UI and agents can show it.
import { appCipher } from "@/lib/core/crypto";
import { FinanceError } from "@/lib/core/domain";
import { getConnections, type Connections } from "@/lib/core/config";
import { company, financeStore } from "@/lib/core/server";
import { normName } from "@/lib/core/text";
import { QboOAuth, type TokenSource } from "./oauth";
import { ComposioQbo } from "./composio";

const PROD = "https://quickbooks.api.intuit.com", SANDBOX = "https://sandbox-quickbooks.api.intuit.com";
export const MINOR = 75;
export type QboEntity = Record<string, any>;

export function qboConfigured(c: Connections): boolean {
  const q = c.quickbooks;
  if (q.mode === "oauth") return !!(q.clientId && q.clientSecret && q.redirectUri);
  if (q.mode === "composio") return !!(q.composioApiKey && q.composioConnectedAccountId);
  return false;
}
export function qboRedirectUri(c: Connections): string {
  return c.quickbooks.redirectUri || `${(process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "")}/api/oauth/qbo/callback`;
}

let composioCache: { key: string; src: ComposioQbo } | null = null;
export async function tokenSource(c?: Connections): Promise<TokenSource> {
  const cfg = c ?? (await getConnections());
  const q = cfg.quickbooks;
  if (q.mode === "composio") {
    const key = `${q.composioApiKey}|${q.composioConnectedAccountId}`;
    if (!composioCache || composioCache.key !== key) composioCache = { key, src: new ComposioQbo(q.composioApiKey, q.composioConnectedAccountId) };
    return composioCache.src;
  }
  if (q.mode === "oauth") {
    if (!qboConfigured(cfg)) throw new FinanceError("QBO_NOT_CONFIGURED", false, 503);
    return new QboOAuth(financeStore(), appCipher(), { companyId: company(), realmId: q.realmId || "", environment: q.environment, clientId: q.clientId, clientSecret: q.clientSecret, redirectUri: qboRedirectUri(cfg) });
  }
  throw new FinanceError("QBO_NOT_CONFIGURED", false, 503);
}
export async function qboOAuth(): Promise<QboOAuth> {
  const src = await tokenSource();
  if (!(src instanceof QboOAuth)) throw new FinanceError("QBO_OAUTH_NOT_IN_USE", false, 409);
  return src;
}

export interface QboClient {
  realm: string;
  environment: "sandbox" | "production";
  call: (path: string, init?: { method?: "GET" | "POST"; body?: unknown; form?: FormData }) => Promise<any>;
  get: (path: string) => Promise<any>;
  query: (entity: string, where?: string, max?: number) => Promise<QboEntity[]>;
  batch: (items: { bId: string; operation: "create" | "update" | "delete"; entity: string; body: unknown }[]) => Promise<{ bId: string; ok?: boolean; entity?: QboEntity; error?: string; detail?: string }[]>;
}

export async function qboClient(): Promise<QboClient> {
  const cfg = await getConnections();
  const src = await tokenSource(cfg);
  let realm = await src.realm();
  const environment = cfg.quickbooks.environment;
  const origin = environment === "sandbox" ? SANDBOX : PROD;
  if (!realm && cfg.quickbooks.mode === "composio") {
    // Composio did not expose the realm: find it through the user's companies.
    const token = await src.accessToken();
    const r = await fetch(`${origin}/v3/company/-/companyinfo/-?minorversion=${MINOR}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => null) : null;
    realm = j?.CompanyInfo?.Id ? String(j.CompanyInfo.Id) : null;
  }
  if (!realm) throw new FinanceError("QBO_NOT_CONNECTED", false, 428);
  const base = `${origin}/v3/company/${encodeURIComponent(realm)}`;
  const call: QboClient["call"] = async (path, init = {}) => {
    const url = `${base}${path}${path.includes("?") ? "&" : "?"}minorversion=${MINOR}`;
    const run = async (force = false) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${await src.accessToken({ force })}`, Accept: "application/json" };
      let body: BodyInit | undefined;
      if (init.form) body = init.form;
      else if (init.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(init.body); }
      return fetch(url, { method: init.method || (body ? "POST" : "GET"), headers, body, cache: "no-store" });
    };
    let r = await run();
    if (r.status === 401) r = await run(true);
    if (r.status === 429 || r.status === 503) {
      const wait = Math.min(5000, (parseInt(r.headers.get("retry-after") || "1", 10) || 1) * 1000);
      await new Promise((res) => setTimeout(res, wait));
      r = await run();
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const fault = j?.Fault?.Error?.[0];
      if (r.status === 401) throw new FinanceError("AUTH_EXPIRED", false, 401);
      throw new FinanceError(`QBO_${r.status}: ${fault ? `${fault.Message} — ${fault.Detail || ""}` : JSON.stringify(j).slice(0, 300)}`, r.status === 429 || r.status >= 500, 502);
    }
    return j;
  };
  const query: QboClient["query"] = async (entity, where = "", max = 10_000) => {
    const out: QboEntity[] = [];
    for (let p = 0; p * 1000 < max; p++) {
      const q = `select * from ${entity}${where ? " where " + where : ""} startposition ${p * 1000 + 1} maxresults 1000`;
      const r = await call(`/query?query=${encodeURIComponent(q)}`);
      const rows = r.QueryResponse?.[entity] ?? [];
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  };
  const batch: QboClient["batch"] = async (items) => {
    const results: Awaited<ReturnType<QboClient["batch"]>> = [];
    for (let i = 0; i < items.length; i += 30) {
      const chunk = items.slice(i, i + 30);
      const r = await call("/batch", { body: { BatchItemRequest: chunk.map((x) => ({ bId: x.bId, operation: x.operation, [x.entity]: x.body })) } });
      for (const item of r.BatchItemResponse ?? []) {
        if (item.Fault) results.push({ bId: item.bId, error: item.Fault.Error?.[0]?.Message || "fault", detail: item.Fault.Error?.[0]?.Detail });
        else { const key = Object.keys(item).find((k) => k !== "bId"); results.push({ bId: item.bId, ok: true, entity: key ? item[key] : undefined }); }
      }
    }
    return results;
  };
  return { realm, environment, call, get: (path) => call(path), query, batch };
}

// ------------------------------------------------------------ reference data
export interface QboRef { id: string; name: string }
export interface QboAccountRef extends QboRef { type: string; subType: string | null; fullyQualifiedName: string }
export interface QboTaxCodeRef extends QboRef { rate: number | null }
export interface QboTermRef extends QboRef { type: string; dueDays: number | null; dayOfMonthDue: number | null }
export interface QboVendorRef extends QboRef { email: string | null; termId: string | null; active: boolean }
export interface QboCustomerRef extends QboRef { email: string | null; active: boolean }
export interface QboRefData { realm: string; fetchedAt: number; vendors: QboVendorRef[]; accounts: QboAccountRef[]; classes: QboRef[]; taxCodes: QboTaxCodeRef[]; terms: QboTermRef[]; customers: QboCustomerRef[] }

let refCache: QboRefData | null = null;
export function invalidateRefData() { refCache = null; }
export async function qboRefData(fresh = false): Promise<QboRefData> {
  if (!fresh && refCache && Date.now() - refCache.fetchedAt < 10 * 60_000) return refCache;
  const api = await qboClient();
  const [vendors, accounts, classes, taxCodes, taxRates, terms, customers] = await Promise.all([
    api.query("Vendor", "Active = true"),
    api.query("Account", "AccountType IN ('Expense', 'Cost of Goods Sold', 'Other Expense') AND Active = true"),
    api.query("Class", "Active = true").catch(() => [] as QboEntity[]),
    api.query("TaxCode").catch(() => [] as QboEntity[]),
    api.query("TaxRate").catch(() => [] as QboEntity[]),
    api.query("Term").catch(() => [] as QboEntity[]),
    api.query("Customer", "Active = true").catch(() => [] as QboEntity[]),
  ]);
  const rateById = new Map<string, number>(taxRates.map((r) => [String(r.Id), Number(r.RateValue ?? 0)]));
  const data: QboRefData = {
    realm: api.realm, fetchedAt: Date.now(),
    vendors: vendors.map((v) => ({ id: String(v.Id), name: v.DisplayName || v.CompanyName || "", email: v.PrimaryEmailAddr?.Address || null, termId: v.TermRef?.value ? String(v.TermRef.value) : null, active: v.Active !== false })),
    accounts: accounts.map((a) => ({ id: String(a.Id), name: a.Name, fullyQualifiedName: a.FullyQualifiedName || a.Name, type: a.AccountType, subType: a.AccountSubType || null })),
    classes: classes.map((c) => ({ id: String(c.Id), name: c.FullyQualifiedName || c.Name })),
    taxCodes: taxCodes.filter((t) => t.Active !== false).map((t) => { const purchaseRate = t.PurchaseTaxRateList?.TaxRateDetail?.[0]?.TaxRateRef?.value; return { id: String(t.Id), name: t.Name, rate: purchaseRate ? rateById.get(String(purchaseRate)) ?? null : null }; }),
    terms: terms.map((t) => ({ id: String(t.Id), name: t.Name, type: t.Type, dueDays: t.DueDays ?? null, dayOfMonthDue: t.DayOfMonthDue ?? null })),
    customers: customers.map((c) => ({ id: String(c.Id), name: c.DisplayName || c.CompanyName || "", email: c.PrimaryEmailAddr?.Address || null, active: c.Active !== false })),
  };
  refCache = data;
  return data;
}

// Supplier identity on an invoice → QuickBooks vendor (trading names,
// address segments and "T/A" splits tried; score 1.0 exact, 0.8 unique
// normalised / contained, 0.6 ambiguous, 0.5 loose).
export function vendorByName(ref: Pick<QboRefData, "vendors">, name: string): { vendor: QboVendorRef | null; score: number } {
  const raw = (name || "").trim().toLowerCase();
  if (!raw) return { vendor: null, score: 0 };
  const segments = raw.split(/\s+t\/a\s+|\s+t\.a\.?\s+|\btrading\s+as\b|[,;\n]+/i).map((s) => s.trim()).filter((s) => s.length >= 2);
  const candidates = [...new Set([raw, ...segments])];
  for (const c of candidates) { const exact = ref.vendors.find((v) => v.name.trim().toLowerCase() === c); if (exact) return { vendor: exact, score: 1 }; }
  let ambiguous: QboVendorRef | null = null;
  for (const c of candidates) {
    const n = normName(c); if (!n) continue;
    const normalised = ref.vendors.filter((v) => normName(v.name) === n);
    if (normalised.length === 1) return { vendor: normalised[0], score: 0.8 };
    if (normalised.length > 1 && !ambiguous) ambiguous = normalised[0];
  }
  const n = normName(raw), padded = ` ${n} `;
  const contained = ref.vendors.filter((v) => { const vn = normName(v.name); return vn.length >= 4 && padded.includes(` ${vn} `); });
  if (contained.length === 1) return { vendor: contained[0], score: 0.8 };
  if (contained.length > 1 && !ambiguous) ambiguous = contained.sort((a, b) => normName(b.name).length - normName(a.name).length)[0];
  if (ambiguous) return { vendor: ambiguous, score: 0.6 };
  const loose = ref.vendors.find((v) => { const vn = normName(v.name); return vn.length > 3 && n.length > 3 && (vn.includes(n) || n.includes(vn)); });
  return loose ? { vendor: loose, score: 0.5 } : { vendor: null, score: 0 };
}
export function accountByName(ref: Pick<QboRefData, "accounts">, name: string): QboAccountRef | null {
  const raw = (name || "").trim().toLowerCase();
  return ref.accounts.find((a) => a.name.toLowerCase() === raw || a.fullyQualifiedName.toLowerCase() === raw) || ref.accounts.find((a) => normName(a.name) === normName(raw)) || null;
}
// Classes are customer / project names; collisions are returned in full so a
// caller treats more than one as ambiguous.
export function classByCustomer(ref: Pick<QboRefData, "classes">, customerName: string): QboRef[] {
  const raw = (customerName || "").trim().toLowerCase();
  if (!raw) return [];
  const exact = ref.classes.filter((c) => c.name.toLowerCase() === raw);
  if (exact.length) return exact;
  const n = normName(raw);
  const same = ref.classes.filter((c) => normName(c.name) === n);
  if (same.length) return same;
  const parts = n.split(" ").filter((p) => p.length > 2);
  if (parts.length < 2) return [];
  return ref.classes.filter((c) => { const cn = normName(c.name); return parts.every((p) => cn.includes(p)); });
}
// Near-miss spellings for the human review queue (never used to auto-post).
export function classByCustomerFuzzy(ref: Pick<QboRefData, "classes">, customerName: string): QboRef[] {
  const parts = normName(customerName || "").split(" ").filter((p) => p.length > 2 && p !== "and" && p !== "mr" && p !== "mrs");
  if (parts.length < 2) return [];
  return ref.classes.filter((c) => { const tokens = normName(c.name).split(" ").filter(Boolean); return parts.every((p) => tokens.some((t) => tokenNear(p, t))); });
}
export function tokenNear(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (edits++) return false;
    if (a.length === b.length) { if (a[i + 1] === b[j] && a[i] === b[j + 1]) { i += 2; j += 2; } else { i++; j++; } }
    else if (a.length > b.length) i++; else j++;
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
export function termById(ref: Pick<QboRefData, "terms">, id: string | null): QboTermRef | null { return id ? ref.terms.find((t) => t.id === id) || null : null; }

// ----------------------------------------------------------------- VAT codes
export type VatKind = "standard" | "zero" | "exempt" | "reverseCharge";
export interface TaxCodeConfig { standard: string | null; zero: string | null; exempt: string | null; reverseCharge: string | null; names: Record<string, string>; detectedAt: string }
export async function taxCodeConfig(ref: QboRefData, fresh = false): Promise<TaxCodeConfig> {
  const store = financeStore();
  if (!fresh) { const row = await store.get<TaxCodeConfig>(company(), "CONFIG#qbo-taxcodes"); if (row?.data?.standard) return row.data; }
  const pick = (test: (name: string, rate: number | null) => boolean) => ref.taxCodes.find((t) => test(t.name.toLowerCase(), t.rate)) || null;
  const standard = pick((n) => /20\.?0?%\s*s\b|standard/.test(n) && !/rc|reverse/.test(n)) || pick((n, r) => r === 20 && !/rc|reverse/.test(n));
  const zero = pick((n) => /0\.?0?%\s*z\b|zero/.test(n)) || pick((n, r) => r === 0 && /z\b/.test(n));
  const exempt = pick((n) => /exempt/.test(n) && !/rc|reverse/.test(n));
  const reverseCharge = pick((n) => /\brc\b|reverse charge/.test(n) && /20/.test(n)) || pick((n) => /\brc\b|reverse charge/.test(n));
  const cfg: TaxCodeConfig = { standard: standard?.id || null, zero: zero?.id || null, exempt: exempt?.id || null, reverseCharge: reverseCharge?.id || null, names: Object.fromEntries(ref.taxCodes.map((t) => [t.id, t.name])), detectedAt: new Date().toISOString() };
  const existing = await store.get<TaxCodeConfig>(company(), "CONFIG#qbo-taxcodes");
  await store.transact(company(), [{ key: "CONFIG#qbo-taxcodes", expected: existing?.version ?? null, data: cfg }]).catch(() => {});
  return cfg;
}
export function vatKindFor(net: number, vat: number, text = ""): VatKind | null {
  if (/reverse\s*charge/i.test(text)) return "reverseCharge";
  if (net <= 0) return null;
  const ratio = vat / net;
  if (Math.abs(ratio - 0.2) <= 0.015) return "standard";
  if (Math.abs(vat) < 0.005) return /exempt/i.test(text) ? "exempt" : "zero";
  return null;
}

// --------------------------------------------------------------------- writes
export interface WriteResult<T = QboEntity> { dryRun: boolean; payload: unknown; entity: T | null }
export async function postingEnabled(): Promise<boolean> { return (await getConnections()).quickbooks.postBills; }
async function writeGate<T = QboEntity>(path: string, payload: unknown, opts: { dryRun?: boolean } = {}): Promise<WriteResult<T>> {
  if (opts.dryRun || !(await postingEnabled())) return { dryRun: true, payload, entity: null };
  const api = await qboClient();
  const r = await api.call(path, { body: payload });
  const key = Object.keys(r).find((k) => !["time"].includes(k));
  return { dryRun: false, payload, entity: key ? r[key] : r };
}
export interface NewVendor { displayName: string; email?: string | null; termId?: string | null }
export async function createVendor(v: NewVendor, opts: { dryRun?: boolean } = {}) {
  const payload: QboEntity = { DisplayName: v.displayName.trim().slice(0, 100), ...(v.email ? { PrimaryEmailAddr: { Address: v.email } } : {}), ...(v.termId ? { TermRef: { value: v.termId } } : {}) };
  const r = await writeGate("/vendor", payload, opts);
  if (!r.dryRun) invalidateRefData();
  return r;
}
export interface NewBillLine { amount: number; accountId: string; classId?: string | null; taxCodeId?: string | null; description?: string }
export interface NewBill { vendorId: string; txnDate: string; dueDate: string; docNumber: string; privateNote?: string; lines: NewBillLine[] }
export async function findBill(vendorId: string, docNumber: string): Promise<QboEntity | null> {
  const api = await qboClient();
  const quote = (v: string) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const rows = await api.query("Bill", `VendorRef = '${quote(vendorId)}' AND DocNumber = '${quote(docNumber)}'`, 1000);
  return rows[0] || null;
}
const writeListeners: (() => void)[] = [];
export function onQboWrite(fn: () => void) { writeListeners.push(fn); }
const notifyWrite = () => { for (const fn of writeListeners) { try { fn(); } catch { /* ignore */ } } };
export async function createBill(b: NewBill, opts: { dryRun?: boolean; skipDuplicateCheck?: boolean } = {}) {
  if (!b.lines.length) throw new FinanceError("BILL_NO_LINES", false, 422);
  if (!opts.skipDuplicateCheck && !opts.dryRun && (await postingEnabled())) {
    const dup = await findBill(b.vendorId, b.docNumber);
    if (dup) throw new FinanceError(`BILL_DUPLICATE: QuickBooks bill ${dup.Id} already has number ${b.docNumber} for this supplier`, false, 409);
  }
  const payload: QboEntity = {
    VendorRef: { value: b.vendorId }, TxnDate: b.txnDate, DueDate: b.dueDate, DocNumber: b.docNumber.slice(0, 21), PrivateNote: (b.privateNote || "").slice(0, 4000), GlobalTaxCalculation: "TaxExcluded",
    Line: b.lines.map((l, i) => ({ Id: String(i + 1), DetailType: "AccountBasedExpenseLineDetail", Amount: Math.round(l.amount * 100) / 100, Description: (l.description || "").slice(0, 4000), AccountBasedExpenseLineDetail: { AccountRef: { value: l.accountId }, ...(l.classId ? { ClassRef: { value: l.classId } } : {}), ...(l.taxCodeId ? { TaxCodeRef: { value: l.taxCodeId } } : {}), BillableStatus: "NotBillable" } })),
  };
  const r = await writeGate("/bill", payload, opts);
  if (!r.dryRun) notifyWrite();
  return r;
}
export async function uploadAttachable(bytes: Uint8Array, fileName: string, contentType: string, link: { entityType: "Bill" | "Invoice" | "Vendor"; entityId: string }, opts: { dryRun?: boolean } = {}): Promise<WriteResult> {
  if (bytes.length > 10 * 1024 * 1024) throw new FinanceError("ATTACHMENT_TOO_LARGE", false, 413);
  const meta = { FileName: fileName.slice(0, 1000), ContentType: contentType, AttachableRef: [{ EntityRef: { type: link.entityType, value: link.entityId }, IncludeOnSend: false }] };
  if (opts.dryRun || !(await postingEnabled())) return { dryRun: true, payload: meta, entity: null };
  const form = new FormData();
  form.append("file_metadata_01", new Blob([JSON.stringify(meta)], { type: "application/json" }), "attachment.json");
  form.append("file_content_01", new Blob([bytes as BlobPart], { type: contentType }), fileName);
  const api = await qboClient();
  const r = await api.call("/upload", { method: "POST", form });
  const item = r.AttachableResponse?.[0];
  if (!item || item.Fault) throw new FinanceError(`QBO_UPLOAD_FAILED: ${item?.Fault?.Error?.[0]?.Message || "no response"}`, false, 502);
  return { dryRun: false, payload: meta, entity: item.Attachable };
}
export async function updateBill(billId: string, mutate: (bill: QboEntity) => QboEntity, opts: { dryRun?: boolean } = {}): Promise<WriteResult & { before: QboEntity }> {
  const api = await qboClient();
  const current = (await api.call(`/bill/${encodeURIComponent(billId)}`)).Bill;
  if (!current) throw new FinanceError("BILL_NOT_FOUND", false, 404);
  const before = JSON.parse(JSON.stringify(current)) as QboEntity;
  const payload = mutate(JSON.parse(JSON.stringify(current)) as QboEntity);
  payload.Id = current.Id; payload.SyncToken = current.SyncToken; payload.sparse = false;
  const r = await writeGate("/bill?operation=update", payload, opts);
  if (!r.dryRun) notifyWrite();
  return { ...r, before };
}
export async function updateBillFields(billId: string, patch: Partial<{ DueDate: string; PrivateNote: string }>, opts: { dryRun?: boolean } = {}) {
  return updateBill(billId, (bill) => ({ ...bill, ...patch }), opts);
}
// Customer invoices are never created by this system: the final invoice is a
// human decision in QuickBooks (see docs/AGENTS.md hard rules).
export async function createInvoice(): Promise<never> { throw new FinanceError("INVOICE_WRITE_NOT_PERMITTED", false, 501); }
