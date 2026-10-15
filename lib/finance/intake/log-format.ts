// Daily supplier-invoice log — pure helpers (no I/O): the day window in the
// company time zone, INTAKE# records → flat rows, totals by state and
// category, and the RFC-4180 CSV Excel opens cleanly (UTF-8 BOM, CRLF, quoted
// fields, formula-prefix guard). log.ts does the reads and the email.
import { localDate, TIMEZONE } from "@/lib/core/text";
import type { IntakeRecord, IntakeState } from "./intake";

export interface LogWindow { from: string; to: string; label: string; date: string | null }

export interface IntakeLogRow {
  sha256: string;
  received: string;            // ISO, first arrival
  touchedAt: string;           // the timestamp that put the record in the window
  mailbox: string;
  sender: string | null;
  fileName: string;
  vendor: string | null;
  docNumber: string | null;
  invoiceDate: string | null;  // YYYY-MM-DD
  dueDate: string | null;      // YYYY-MM-DD
  net: number | null;
  vat: number | null;
  gross: number | null;
  vatKind: string | null;      // standard | zero | exempt | reverseCharge (joined with " + " when mixed)
  category: string | null;     // QuickBooks account name(s)
  className: string | null;    // class = customer / project
  state: IntakeState;
  billId: string | null;
  reasons: string;             // "; " joined
  confidence: number;
  decidedBy: string | null;
}

export interface IntakeLogTotals {
  rows: number;
  posted: number; proposed: number; held: number; duplicate: number; notInvoice: number; rejected: number;
  review: number;              // proposed + held — what a human still has to look at
  net: number; vat: number; gross: number;   // posted + proposed + held only
  byState: { state: IntakeState; count: number; gross: number }[];
  byCategory: { category: string; count: number; net: number; vat: number; gross: number }[];
}

const DAY = 86_400_000;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

export { localDate };

// Midnight in the company time zone on the given date, as a UTC instant.
export function dayStart(date: string, timeZone = TIMEZONE): string {
  if (!isoDate.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error("DATE_INVALID");
  const guess = Date.parse(`${date}T00:00:00Z`);
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(new Date(guess))) % 24;
  return new Date(guess - h * 3_600_000).toISOString();
}

// date → that local day; from/to → inclusive local days; since/until → ISO instants.
export function logWindow(opts: { date?: string; from?: string; to?: string; since?: string; until?: string } = {}, timeZone = TIMEZONE): LogWindow {
  if (opts.since) {
    const a = Date.parse(opts.since), b = opts.until ? Date.parse(opts.until) : Date.now();
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) throw new Error("SINCE_INVALID");
    return { from: new Date(a).toISOString(), to: new Date(b).toISOString(), label: `${localDate(new Date(a), timeZone)}_${localDate(new Date(b), timeZone)}`, date: null };
  }
  const from = opts.from || opts.date || localDate(new Date(), timeZone);
  const to = opts.to || from;
  const start = dayStart(from, timeZone);
  const end = new Date(Date.parse(dayStart(to, timeZone)) + DAY).toISOString(); // next local midnight (DST shift tolerated: ±1h on change days)
  if (Date.parse(end) <= Date.parse(start)) throw new Error("RANGE_INVALID");
  return { from: start, to: end, label: from === to ? from : `${from}_${to}`, date: from === to ? from : null };
}

const num = (v: unknown): number | null => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "")); return Number.isFinite(n) ? n : null; };
const round2 = (n: number) => Math.round(n * 100) / 100;
const uniq = (xs: (string | null | undefined)[]) => Array.from(new Set(xs.filter((x): x is string => !!x)));

function touchedWithin(r: IntakeRecord, w: LogWindow): string | null {
  const from = Date.parse(w.from), to = Date.parse(w.to);
  const stamps = [r.createdAt, r.updatedAt, r.decidedAt, r.qbo?.postedAt, ...(r.arrivals || []).map((a) => a.receivedAt)].filter((s): s is string => typeof s === "string");
  const hits = stamps.filter((s) => { const t = Date.parse(s); return t >= from && t < to; });
  return hits.length ? hits.sort()[0] : null;
}

export function rowFromRecord(r: IntakeRecord, touchedAt: string): IntakeLogRow {
  const first = r.arrivals?.[0];
  const res = r.resolution; const x = r.extraction;
  const lines = res?.lines || [];
  return {
    sha256: r.sha256,
    received: first?.receivedAt || r.createdAt,
    touchedAt,
    mailbox: first?.mailbox || "",
    sender: first?.from || null,
    fileName: first?.fileName || "",
    vendor: res?.vendorName || x?.supplierIdentity || null,
    docNumber: res?.docNumber || x?.documentNumber || null,
    invoiceDate: res?.txnDate || x?.confirmedIsoDate || null,
    dueDate: res?.dueDate || null,
    net: res ? round2(res.totals.net) : num(x?.net),
    vat: res ? round2(res.totals.vat) : num(x?.vat),
    gross: res ? round2(res.totals.gross) : num(x?.gross),
    vatKind: uniq(lines.map((l) => l.vatKind)).join(" + ") || null,
    category: uniq(lines.map((l) => l.accountName)).join(" + ") || null,
    className: res?.className || uniq(lines.map((l) => l.className)).join(" + ") || null,
    state: r.state,
    billId: r.qbo?.billId || null,
    reasons: (r.reasons || []).join("; "),
    confidence: r.confidence ?? 0,
    decidedBy: r.decidedBy || null,
  };
}

export function rowsFromRecords(records: IntakeRecord[], w: LogWindow): IntakeLogRow[] {
  const out: IntakeLogRow[] = [];
  for (const r of records) {
    if (!r || typeof r.sha256 !== "string") continue;
    const touched = touchedWithin(r, w);
    if (touched) out.push(rowFromRecord(r, touched));
  }
  return out.sort((a, b) => a.received.localeCompare(b.received));
}

const COUNTED: IntakeState[] = ["posted", "proposed", "held"];

export function totalsFor(records: IntakeRecord[], rows: IntakeLogRow[]): IntakeLogTotals {
  const byStateMap = new Map<IntakeState, { count: number; gross: number }>();
  const byCat = new Map<string, { count: number; net: number; vat: number; gross: number }>();
  const bySha = new Map(records.map((r) => [r.sha256, r] as const));
  let net = 0, vat = 0, gross = 0;
  const count = { posted: 0, proposed: 0, held: 0, duplicate: 0, notInvoice: 0, rejected: 0 };
  for (const row of rows) {
    const s = byStateMap.get(row.state) || { count: 0, gross: 0 };
    s.count += 1; s.gross = round2(s.gross + (row.gross || 0)); byStateMap.set(row.state, s);
    if (row.state === "not_invoice") count.notInvoice += 1; else count[row.state] += 1;
    if (!COUNTED.includes(row.state)) continue;
    net = round2(net + (row.net || 0)); vat = round2(vat + (row.vat || 0)); gross = round2(gross + (row.gross || 0));
    const lines = bySha.get(row.sha256)?.resolution?.lines || [];
    if (lines.length) {
      for (const l of lines) {
        const k = l.accountName || "Uncoded";
        const c = byCat.get(k) || { count: 0, net: 0, vat: 0, gross: 0 };
        c.net = round2(c.net + (l.amount || 0)); c.vat = round2(c.vat + (l.vat || 0)); c.gross = round2(c.gross + (l.amount || 0) + (l.vat || 0)); byCat.set(k, c);
      }
      for (const k of uniq(lines.map((l) => l.accountName || "Uncoded"))) byCat.get(k)!.count += 1;
    } else {
      const c = byCat.get("Uncoded") || { count: 0, net: 0, vat: 0, gross: 0 };
      c.count += 1; c.net = round2(c.net + (row.net || 0)); c.vat = round2(c.vat + (row.vat || 0)); c.gross = round2(c.gross + (row.gross || 0)); byCat.set("Uncoded", c);
    }
  }
  return {
    rows: rows.length, ...count, review: count.proposed + count.held, net, vat, gross,
    byState: Array.from(byStateMap, ([state, v]) => ({ state, ...v })).sort((a, b) => a.state.localeCompare(b.state)),
    byCategory: Array.from(byCat, ([category, v]) => ({ category, ...v })).sort((a, b) => b.gross - a.gross || a.category.localeCompare(b.category)),
  };
}

// ------------------------------------------------------------------- CSV
export const CSV_COLUMNS = [
  "Received", "Mailbox", "Sender", "Supplier", "Document no", "Invoice date", "Due date",
  "Net", "VAT", "Gross", "VAT kind", "Category", "Class / project", "State", "QuickBooks bill", "Reasons", "File", "Confidence", "Decided by", "Intake id",
] as const;

const numeric = /^-?\d+(\.\d+)?$/;
// RFC-4180: quote when the field has a comma, quote or line break; double embedded quotes.
// Excel guard: a leading = + - @ or tab on non-numeric text is a formula — prefix an apostrophe.
export function csvField(v: unknown): string {
  let s = v == null ? "" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v);
  if (s && !numeric.test(s) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const localStamp = (iso: string, timeZone = TIMEZONE) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value || "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
};

const money = (n: number | null) => (n == null ? "" : n.toFixed(2));
export const STATE_LABEL: Record<IntakeState, string> = { posted: "posted", proposed: "proposed", held: "held", duplicate: "duplicate", not_invoice: "not an invoice", rejected: "rejected" };

export function intakeLogCsv(rows: IntakeLogRow[], timeZone = TIMEZONE): string {
  const lines = [CSV_COLUMNS.map(csvField).join(",")];
  for (const r of rows) {
    lines.push([
      localStamp(r.received, timeZone), r.mailbox, r.sender, r.vendor, r.docNumber, r.invoiceDate, r.dueDate,
      money(r.net), money(r.vat), money(r.gross), r.vatKind, r.category, r.className, STATE_LABEL[r.state] || r.state, r.billId, r.reasons, r.fileName, r.confidence.toFixed(2), r.decidedBy, r.sha256,
    ].map(csvField).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
