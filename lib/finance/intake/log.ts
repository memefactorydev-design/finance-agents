// Daily supplier-invoice log: a draft email for the accountant / owner listing
// every invoice processed that day — supplier, category, VAT, state — with a
// CSV (the "Excel log") attached. Rows = every INTAKE# record touched in the
// window (created / updated / decided / posted / arrived). The email goes
// through sendFromAccounts, which in drafts-only mode leaves it in the accounts
// mailbox's Drafts for a human to send. Pure row/CSV helpers live in log-format.ts.
import { all } from "@/lib/core/store";
import { FinanceError } from "@/lib/core/domain";
import { getConnections, type Connections } from "@/lib/core/config";
import { company, financeStore } from "@/lib/core/server";
import { postingEnabled } from "@/lib/qbo/client";
import { sendFromAccounts, type AccountsMailResult } from "@/lib/mail/outbound";
import type { IntakeRecord } from "./intake";
import { logWindow, rowsFromRecords, totalsFor, intakeLogCsv, type IntakeLogRow, type IntakeLogTotals, type LogWindow } from "./log-format";

export { intakeLogCsv, logWindow, type IntakeLogRow, type IntakeLogTotals, type LogWindow } from "./log-format";

const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024; // inline attachments are base64 in the provider payload — stay well under provider limits

export interface IntakeLog { window: LogWindow; rows: IntakeLogRow[]; totals: IntakeLogTotals; posting: boolean }
export interface IntakeLogOptions { date?: string; from?: string; to?: string; since?: string; until?: string }

// Recipients: explicit list → the accountant → the owner.
export function intakeLogRecipients(cfg: Connections, to?: string[] | null): string[] {
  const fromArgs = (to || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (fromArgs.length) return Array.from(new Set(fromArgs));
  return [cfg.company.accountantEmail || cfg.company.ownerEmail].map((s) => (s || "").toLowerCase()).filter(Boolean);
}

function windowOrThrow(opts: IntakeLogOptions, timeZone: string): LogWindow {
  try { return logWindow(opts, timeZone); }
  catch (e) { throw new FinanceError(e instanceof Error && /INVALID/.test(e.message) ? e.message : "DATE_INVALID", false, 422); }
}

export async function buildIntakeLog(opts: IntakeLogOptions = {}): Promise<IntakeLog> {
  const cfg = await getConnections();
  const window = windowOrThrow(opts, cfg.company.timezone);
  const rows = (await all<IntakeRecord>(financeStore(), company(), "INTAKE#")).map((r) => r.data).filter((d) => d && typeof d.sha256 === "string" && Array.isArray(d.arrivals));
  const logRows = rowsFromRecords(rows, window);
  return { window, rows: logRows, totals: totalsFor(rows, logRows), posting: await postingEnabled() };
}

export function intakeLogFileName(window: LogWindow) { return `supplier-invoices-${window.label}.csv`; }

// ----------------------------------------------------------------- email
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
const P = (s: string) => `<p style="margin:0 0 12px 0">${s}</p>`;
const UL = (items: string[]) => `<ul style="margin:0 0 12px 18px;padding:0">${items.map((i) => `<li style="margin:0 0 4px 0">${i}</li>`).join("")}</ul>`;
const TABLE = (head: string[], rows: string[][], rightCols: number[] = []) => {
  const th = head.map((h, i) => `<th style="text-align:${rightCols.includes(i) ? "right" : "left"};padding:4px 8px;border-bottom:1px solid #cbd5e1;font-weight:600">${esc(h)}</th>`).join("");
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td style="text-align:${rightCols.includes(i) ? "right" : "left"};padding:4px 8px;border-bottom:1px solid #e2e8f0;white-space:nowrap">${c}</td>`).join("")}</tr>`).join("");
  return `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:0 0 12px 0;font-size:13px">${th ? `<thead><tr>${th}</tr></thead>` : ""}<tbody>${tr}</tbody></table>`;
};
const wrap = (parts: string[]) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:640px">${parts.join("")}</div>`;
const longDate = (iso: string, timeZone: string) => {
  const d = new Date(iso.length === 10 ? iso + "T00:00:00Z" : iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone }).format(d);
};

export function intakeLogHtml(log: IntakeLog, opts: { csvName?: string | null; recipientsName?: string; currency?: string; timeZone?: string; companyName?: string } = {}): { subject: string; html: string } {
  const currency = opts.currency || "GBP", timeZone = opts.timeZone || "Europe/London";
  const money = (v: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: 2 }).format(Number(v) || 0);
  const m = (n: number | null) => (n == null ? "—" : money(n));
  const date = log.window.label;
  const single = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const dateLabel = single ? longDate(date, timeZone) : date.replace("_", " to ");
  const subject = `Supplier invoices processed — ${dateLabel} — ${log.totals.posted} posted / ${log.totals.review} for review`;
  const mailboxShort = (mb: string) => esc(mb.split("@")[0] + "@");
  const stateLabel = (s: string) => ({ posted: "Posted", proposed: "Proposed", held: "Held", duplicate: "Duplicate", not_invoice: "Not an invoice", rejected: "Rejected" } as Record<string, string>)[s] || esc(s);
  const stamp = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? esc(iso) : new Intl.DateTimeFormat("en-GB", { timeZone, ...(single ? {} : { day: "2-digit", month: "2-digit" }), hour: "2-digit", minute: "2-digit", hour12: false }).format(d); };
  const reviewRows = log.rows.filter((r) => r.state === "proposed" || r.state === "held");
  const t = log.totals;
  const csvName = opts.csvName === undefined ? intakeLogFileName(log.window) : opts.csvName;
  const html = wrap([
    P(`Dear ${esc(opts.recipientsName || "all")},`),
    P(`Supplier invoice intake for <strong>${esc(dateLabel)}</strong>: ${log.rows.length} ${log.rows.length === 1 ? "document" : "documents"} processed — <strong>${t.posted} posted</strong> to QuickBooks, <strong>${t.review} for review</strong> (${t.proposed} proposed, ${t.held} held)${t.duplicate ? `, ${t.duplicate} duplicate` : ""}${t.notInvoice ? `, ${t.notInvoice} not an invoice` : ""}${t.rejected ? `, ${t.rejected} rejected` : ""}.`),
    log.posting === false ? P("<strong>QuickBooks posting is switched off</strong>: items marked posted are dry-run payloads only.") : "",
    log.rows.length
      ? TABLE(["Time", "Supplier", "Document", "Net", "VAT", "Gross", "VAT kind", "Category", "Class", "State", "Mailbox"],
          log.rows.map((r) => [stamp(r.received), `<span style="white-space:normal">${esc(r.vendor || r.sender || "—")}</span>`, esc(r.docNumber || "—"), m(r.net), m(r.vat), m(r.gross), esc(r.vatKind || "—"), `<span style="white-space:normal">${esc(r.category || "—")}</span>`, `<span style="white-space:normal">${esc(r.className || "—")}</span>`, r.billId ? `${stateLabel(r.state)} · bill ${esc(r.billId)}` : stateLabel(r.state), mailboxShort(r.mailbox)]),
          [3, 4, 5])
      : P("No supplier invoices were received or processed in this period."),
    log.rows.length ? P(`<strong>Totals</strong> (posted, proposed and held): net ${money(t.net)} · VAT ${money(t.vat)} · gross ${money(t.gross)}.`) : "",
    t.byCategory.length
      ? P("<strong>By category</strong>") + TABLE(["Category", "Invoices", "Net", "VAT", "Gross"], t.byCategory.map((c) => [esc(c.category), String(c.count), money(c.net), money(c.vat), money(c.gross)]), [1, 2, 3, 4])
      : "",
    reviewRows.length
      ? P("<strong>Needs a decision</strong>") + UL(reviewRows.map((r) => `${esc(r.vendor || r.sender || "Unknown supplier")} ${esc(r.docNumber || "")} — ${m(r.gross)} — <span style="color:#64748b">${esc(r.reasons || "no reason recorded")}</span>`))
      : "",
    csvName ? P(`The Excel log is attached (<em>${esc(csvName)}</em>); the full record is in Finance ▸ Supplier invoices.`) : P("The log was too large to attach; download it from Finance ▸ Supplier invoices."),
    P(`Kind regards,<br>${esc(opts.companyName || "")}${opts.companyName ? " " : ""}Accounts`),
  ]);
  return { subject, html };
}

export interface SendIntakeLogResult {
  date: string;                // window label
  window: LogWindow;
  recipients: string[];
  rows: number; posted: number; review: number;
  subject: string;
  csv: { name: string; bytes: number; attached: boolean };
  mail: AccountsMailResult;
}

// `to` here is the recipient list (the date-range end is not needed for the daily log).
export async function sendIntakeLog(opts: Omit<IntakeLogOptions, "to"> & { to?: string[] | null; actor: string; recipientsName?: string }): Promise<SendIntakeLogResult> {
  const { to, actor, recipientsName, ...window } = opts;
  const cfg = await getConnections();
  const log = await buildIntakeLog(window);
  const recipients = intakeLogRecipients(cfg, to);
  if (!recipients.length) throw new FinanceError("NO_LOG_RECIPIENT: set company.accountantEmail or company.ownerEmail", false, 422);
  const csv = intakeLogCsv(log.rows, cfg.company.timezone);
  const bytes = Buffer.from(csv, "utf8");
  const name = intakeLogFileName(log.window);
  const attached = bytes.length <= MAX_ATTACHMENT_BYTES;
  const { subject, html } = intakeLogHtml(log, { csvName: attached ? name : null, recipientsName, currency: cfg.company.currency, timeZone: cfg.company.timezone, companyName: cfg.company.name });
  const mail = await sendFromAccounts({
    to: recipients, subject, html, actor,
    attachments: attached ? [{ name, contentType: "text/csv", contentBytes: bytes.toString("base64") }] : undefined,
  });
  return { date: log.window.label, window: log.window, recipients, rows: log.rows.length, posted: log.totals.posted, review: log.totals.review, subject, csv: { name, bytes: bytes.length, attached }, mail };
}
