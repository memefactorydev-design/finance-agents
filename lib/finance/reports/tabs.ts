// The finance report tabs as plain value matrices — the workbook the owner
// runs the business from, built from the finance store and QuickBooks.
// Everything here is data (numbers as numbers, never formulas); the matrices
// are served by GET /api/finance/reports (JSON or CSV), read by the agents
// through get_sheet_tab, and optionally mirrored to Google Sheets
// (reports/sheets.ts). Manual rows never live in a sheet: they are CASH_ENTRY#
// records (appendCashEntry) and survive every rebuild.
import { r2 } from "@/lib/core/domain";
import { all } from "@/lib/core/store";
import { company, financeStore } from "@/lib/core/server";
import { localDate, nextFriday, normName, shiftDays } from "@/lib/core/text";
import { cashflowOutlook, type CashflowOutlook } from "../cashflow";
import { commissionMonths, commissionStatement, getCommissionConfig, type CommissionConfig, type CommissionStatement, type DesignerCommission } from "../commission";
import { classPnlForProjects, monthlyPnl, shiftMonth, type MonthClassPnl, type MonthlyPnlReport } from "../qbo-pnl";
import { commitmentDates, INFLOW_SECTIONS, listCashEntries, listCommitments, listDisputes, listSupplierProfiles, type CashEntry, type Commitment, type Dispute, type SupplierProfile } from "../suppliers";
import { vendorBalanceDetail, type VendorBalanceReport } from "../vendor-balances";

export type Cell = string | number | boolean | null;
export type Colour = "green" | "red" | "yellow";
export interface ReportTab { tab: string; matrix: Cell[][]; colours: { r: number; c: number; colour: Colour }[]; boldRows: number[]; note: string | null; generatedAt: string; error?: string }

export const TAB = { dashboard: "Dashboard", cashflow: "Cashflow", suppliers: "Suppliers", pnlMonth: "P&L by Month", pnlClass: "P&L by Class", loans: "Loans", cashControl: "Cash Control" } as const;
export const commissionTab = (designerDisplayName: string) => `Commission – ${designerDisplayName}`;
export const HORIZON_DAYS = 90;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (iso: string) => WEEKDAYS[new Date(iso + "T00:00:00Z").getUTCDay()];
export const ukDate = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso || "");

// A small sparse grid that renders to a dense value matrix.
export class Grid {
  cells: Cell[][] = [];
  set(r: number, c: number, v: Cell) { while (this.cells.length <= r) this.cells.push([]); const row = this.cells[r]; while (row.length <= c) row.push(null); row[c] = v; }
  row(r: number, values: Cell[], c0 = 0) { values.forEach((v, i) => this.set(r, c0 + i, v)); }
  get rows() { return this.cells.length; }
  get cols() { return this.cells.reduce((m, r) => Math.max(m, r.length), 0); }
  matrix(): Cell[][] { const cols = this.cols; return this.cells.map((r) => { const out = [...r]; while (out.length < cols) out.push(null); return out; }); }
}
const finish = (tab: string, matrix: Cell[][], extra: Partial<ReportTab> = {}): ReportTab => ({ tab, matrix, colours: [], boldRows: [0], note: null, generatedAt: new Date().toISOString(), ...extra });

// ------------------------------------------------------------------ Cashflow
interface Line { label: string; total: Cell; byDay: Map<number, number>; colours: Map<number, Colour> }
const newLine = (label: string, total: Cell = null): Line => ({ label, total, byDay: new Map(), colours: new Map() });
// Confirmed money replaces projected amounts: consume `candidates` (oldest
// first) up to the confirmed amount, then write the confirmed amount in its
// own cell (green).
const allocateConfirmed = (line: Line, col: number, amount: number, candidates: number[]) => {
  let remaining = amount;
  for (const c of [...candidates].sort((a, b) => a - b)) {
    if (remaining <= 0) break;
    if (line.colours.get(c) === "green") continue;
    const v = line.byDay.get(c) || 0;
    const take = Math.min(v, remaining);
    remaining = r2(remaining - take);
    const left = r2(v - take);
    if (left > 0) line.byDay.set(c, left); else { line.byDay.delete(c); line.colours.delete(c); }
  }
  line.byDay.set(col, r2((line.colours.get(col) === "green" ? line.byDay.get(col) || 0 : 0) + amount));
  line.colours.set(col, "green");
};
const paint = (line: Line, col: number, colour: Colour) => { const cur = line.colours.get(col); const rank = { red: 3, green: 2, yellow: 1 }; if (!cur || rank[colour] > rank[cur]) line.colours.set(col, colour); };

export interface CashflowInputs { outlook: CashflowOutlook; vendors: VendorBalanceReport | null; commitments: Commitment[]; entries: CashEntry[]; today?: string }
// Daily cash forecast over 90 days. Green = approved to pay / confirmed;
// red = must decide (block risk, on hold, pro-forma); yellow = due within 7
// days. Overdue supplier bills land on the next pay Friday.
export function cashflowMatrix(input: CashflowInputs): ReportTab & { closingRow: number; firstDayCol: number; days: string[] } {
  const { outlook, vendors, commitments, entries } = input;
  const today = input.today || outlook.asOf;
  const days = Array.from({ length: HORIZON_DAYS }, (_, i) => shiftDays(today, i));
  const lastDay = days[days.length - 1];
  const C0 = 2; // first day column (A = label, B = open balance / total)
  const dayCol = (iso: string | null | undefined) => { if (!iso) return -1; const i = days.indexOf(iso.slice(0, 10)); return i < 0 ? -1 : C0 + i; };
  const soon = shiftDays(today, 7);
  const friday = nextFriday(today);
  const inWindow = (e: CashEntry) => e.date >= today && e.date <= lastDay;

  const g = new Grid();
  g.row(0, ["Daily Cash Flow Forecast"]);
  g.row(1, [`${ukDate(today)} → ${ukDate(lastDay)} · Opening = QuickBooks book balance of the bank accounts · receipts = project payment schedule + confirmed entries · bills = QuickBooks Vendor Balance Detail (disputed excluded) · green = approved to pay / confirmed · red = must decide (block risk, on hold, pro-forma) · yellow = due within 7 days`]);
  g.row(3, ["", "Open balance / total", ...days.map(weekday)]);
  g.row(4, ["", "", ...days.map(ukDate)]);
  const OPENING = 5;
  g.row(OPENING, ["Opening Balance / bank", outlook.bank.cash]);

  const sections: { heading: string; lines: Line[] }[] = [];
  const section = (heading: string) => { let s = sections.find((x) => x.heading === heading); if (!s) { s = { heading, lines: [] }; sections.push(s); } return s; };
  const place = (line: Line, iso: string | null | undefined, amount: number, colour?: Colour, fallbackCol = -1) => {
    let col = dayCol(iso);
    if (col < 0) col = fallbackCol;
    if (col >= 0) { line.byDay.set(col, r2((line.byDay.get(col) || 0) + amount)); if (colour) paint(line, col, colour); }
  };

  // ---- Inflows
  ["Deposits", "Survey balances", "Final balances", "Merchant payouts", "Finance payouts", "Other", "Director"].forEach(section);
  const stageHeading: Record<string, string> = { deposit: "Deposits", survey: "Survey balances", delivery_balance: "Final balances", installation: "Final balances", retention: "Final balances" };
  for (const l of outlook.inbound.lines) {
    const line = newLine(`${l.client} — ${l.label}${l.invoiceNumber ? ` (${l.invoiceNumber})` : ""}${l.dueDate ? "" : " (no date)"}`, l.amount);
    if (l.dueDate && l.dueDate < today) place(line, today, l.amount, "yellow");
    else if (l.dueDate) place(line, l.dueDate, l.amount, l.dueDate <= soon ? "yellow" : undefined);
    section(stageHeading[l.stage] || "Other").lines.push(line);
  }
  const sectionHeading: Record<string, string> = { merchant: "Merchant payouts", finance: "Finance payouts", other_in: "Other", deposit: "Deposits", survey: "Survey balances", final: "Final balances" };
  for (const e of entries.filter((e) => INFLOW_SECTIONS.includes(e.section) && inWindow(e))) {
    const heading = e.section === "other_in" && /director/i.test(e.label) ? "Director" : sectionHeading[e.section] || "Other";
    const line = newLine(`${e.label}${e.note ? ` — ${e.note}` : ""}${e.confirmed ? "" : " (expected)"}`, e.amount);
    place(line, e.date, e.amount, e.confirmed ? "green" : undefined);
    section(heading).lines.push(line);
  }
  const inflowSections = sections.slice();

  // ---- Outflows
  const outSections: { heading: string; lines: Line[] }[] = [];
  const outSection = (heading: string) => { let s = outSections.find((x) => x.heading === heading); if (!s) { s = { heading, lines: [] }; outSections.push(s); } return s; };
  ["Suppliers", "Credit cards", "Loans", "Wages", "VAT and other taxes", "Overheads", "Other outflows"].forEach(outSection);
  const outlookByVendor = new Map(outlook.outbound.suppliers.map((s) => [s.vendorId || normName(s.vendor), s]));
  const supplierLines = new Map<string, Line>();
  for (const v of vendors?.vendors || []) {
    const openItems = v.items.filter((i) => i.openBalance > 0 && !i.disputed);
    if (!openItems.length) continue;
    const so = outlookByVendor.get(v.vendorId || normName(v.vendor));
    const risk = !!(so?.blockRisk || so?.onHold || so?.proformaOnly);
    const line = newLine(v.vendor + (so?.onHold ? " (on hold)" : so?.proformaOnly ? " (pro-forma)" : so?.blockRisk ? " (block risk)" : ""), v.bills);
    for (const i of openItems) {
      const overdue = !i.dueDate || i.dueDate < today;
      const target = overdue ? friday : i.dueDate!;
      if (target > lastDay) continue;
      const colour: Colour | undefined = risk ? "red" : overdue || target <= soon ? "yellow" : undefined;
      place(line, target, i.openBalance, colour);
    }
    supplierLines.set(normName(v.vendor), line);
    outSection("Suppliers").lines.push(line);
  }
  for (const e of entries.filter((e) => e.section === "supplier" && inWindow(e))) {
    const key = normName(e.label);
    let line = supplierLines.get(key) || Array.from(supplierLines.entries()).find(([k]) => k.includes(key) || key.includes(k))?.[1];
    if (!line) { line = newLine(e.label, e.amount); supplierLines.set(key, line); outSection("Suppliers").lines.push(line); }
    const col = dayCol(e.date);
    if (col >= 0) {
      // A confirmed payment is allocated to the oldest projected bills first,
      // so the Friday run replaces, rather than doubles, what it settles.
      if (e.confirmed) allocateConfirmed(line, col, e.amount, Array.from(line.byDay.keys()).filter((c) => c <= col));
      else place(line, e.date, e.amount, "yellow");
    }
  }
  // Credit cards (one line per card account in QuickBooks), loans, wages, VAT, overheads from standing commitments
  const cardAccounts = outlook.bank.accounts.filter((a) => a.type === "Credit Card" && !a.hidden);
  const kindHeading: Record<Commitment["kind"], string> = { card: "Credit cards", loan: "Loans", payroll: "Wages", tax: "VAT and other taxes", overhead: "Overheads" };
  const commitmentLines = new Map<string, Line>();
  for (const a of cardAccounts) { const l = newLine(a.name, Math.abs(a.balance)); commitmentLines.set(normName(a.name), l); outSection("Credit cards").lines.push(l); }
  const cardLineFor = (name: string) => { const n = normName(name); return commitmentLines.get(n) || Array.from(commitmentLines.entries()).find(([k]) => k && (k.includes(n) || n.includes(k)))?.[1] || null; };
  for (const c of commitments) {
    const key = normName(c.name);
    let line = c.kind === "card" ? cardLineFor(c.name) : null;
    if (!line) { line = newLine(c.name, c.kind === "loan" ? c.balance : null); commitmentLines.set(key, line); outSection(kindHeading[c.kind] || "Overheads").lines.push(line); }
    for (const d of commitmentDates(c, today, lastDay)) {
      const cardWeek = c.kind === "card" && d <= soon;
      place(line, d, c.amount, cardWeek ? "red" : d <= soon ? "yellow" : undefined);
    }
  }
  if (!commitments.some((c) => c.kind === "payroll")) outSection("Wages").lines.push(newLine("Wages (no payroll commitment recorded)", null));
  if (!commitments.some((c) => c.kind === "tax")) outSection("VAT and other taxes").lines.push(newLine("VAT (no tax commitment recorded)", null));
  const entryHeading: Record<string, string> = { overhead: "Overheads", loan: "Loans", wages: "Wages", vat: "VAT and other taxes", other_out: "Other outflows" };
  for (const e of entries.filter((e) => ["overhead", "loan", "wages", "vat", "other_out"].includes(e.section) && inWindow(e))) {
    const key = normName(e.label);
    let line = commitmentLines.get(key) || Array.from(commitmentLines.entries()).find(([k]) => k && (k.includes(key) || key.includes(k)))?.[1];
    if (!line) { line = newLine(`${e.label}${e.note ? ` — ${e.note}` : ""}`, null); commitmentLines.set(key, line); outSection(entryHeading[e.section] || "Other outflows").lines.push(line); }
    const col = dayCol(e.date);
    if (col >= 0) { if (e.confirmed) allocateConfirmed(line, col, e.amount, Array.from(line.byDay.keys()).filter((c) => Math.abs(c - col) <= 7)); else place(line, e.date, e.amount, "yellow"); }
  }

  // ---- Emit
  const colours: { r: number; c: number; colour: Colour }[] = [];
  const boldRows = [0, 3, 4, 5];
  const totals = (lines: Line[]) => { const t = new Array<number>(HORIZON_DAYS).fill(0); for (const l of lines) for (const [c, v] of l.byDay) t[c - C0] = r2(t[c - C0] + v); return t; };
  let r = OPENING + 1;
  const emit = (title: string, secs: { heading: string; lines: Line[] }[], totalLabel: string) => {
    boldRows.push(r); g.row(r++, [title]);
    for (const s of secs) {
      g.row(r++, [s.heading, r2(s.lines.reduce((sum, l) => sum + (typeof l.total === "number" ? l.total : 0), 0)) || null]);
      for (const l of s.lines) {
        g.set(r, 0, `   ${l.label}`); g.set(r, 1, l.total);
        for (const [c, v] of l.byDay) g.set(r, c, v);
        for (const [c, colour] of l.colours) colours.push({ r, c, colour });
        r++;
      }
    }
    const t = totals(secs.flatMap((s) => s.lines));
    boldRows.push(r); g.row(r, [totalLabel, r2(t.reduce((a, b) => a + b, 0)), ...t]);
    return r++;
  };
  const inTotalRow = emit("INFLOWS", inflowSections, "Total Inflows");
  r++;
  const outTotalRow = emit("OUTFLOWS", outSections, "Total Outflows");
  r++;
  const closingRow = r;
  boldRows.push(closingRow);
  const inT = g.cells[inTotalRow], outT = g.cells[outTotalRow];
  let opening = outlook.bank.cash;
  g.set(closingRow, 0, "Closing balance (B = end of horizon)");
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const c = C0 + i;
    g.set(OPENING, c, opening);
    const closing = r2(opening + Number(inT[c] || 0) - Number(outT[c] || 0));
    g.set(closingRow, c, closing);
    opening = closing;
  }
  g.set(closingRow, 1, g.cells[closingRow][C0 + HORIZON_DAYS - 1]);
  g.row(closingRow + 2, [`Bank accounts: ${outlook.bank.accounts.filter((a) => a.type === "Bank").map((a) => `${a.name} ${a.balance.toLocaleString("en-GB")}`).join(" · ") || "none"}; credit cards: ${cardAccounts.map((a) => `${a.name} ${Math.abs(a.balance).toLocaleString("en-GB")}`).join(" · ") || "none"}.`]);
  outlook.notes.forEach((n, i) => g.row(closingRow + 3 + i, [n]));
  return { ...finish(TAB.cashflow, g.matrix(), { colours, boldRows, note: `${colours.length} coloured cells` }), closingRow, firstDayCol: C0, days };
}

// ----------------------------------------------------------------- Suppliers
export function suppliersMatrix(vendors: VendorBalanceReport | null, profiles: SupplierProfile[], disputes: Dispute[], outlook: CashflowOutlook | null): ReportTab {
  const g = new Grid();
  g.row(0, ["Vendor", "Terms", "Statement account?", "Block after (days overdue)", "Safe days", "Pressure", "On hold", "Pays by", "Open balance", "Overdue", "Disputed", "Next due", "Pay Friday", "Block risk", "Notes"]);
  const byVendorId = new Map(profiles.map((p) => [p.vendorId, p]));
  const byName = new Map(profiles.map((p) => [normName(p.vendorName), p]));
  const disputedByVendor = new Map<string, number>();
  for (const d of disputes) { const k = d.vendorId || normName(d.vendor); disputedByVendor.set(k, r2((disputedByVendor.get(k) || 0) + d.amount)); }
  const outlookBy = new Map((outlook?.outbound.suppliers || []).map((s) => [s.vendorId || normName(s.vendor), s]));
  const seen = new Set<string>();
  const termsText = (p?: SupplierProfile | null) => (p?.terms ? (p.terms.kind === "eom_next" ? "Monthly — end of following month" : `Net ${p.terms.days}`) : "");
  const rows: Cell[][] = [];
  const colours: ReportTab["colours"] = [];
  for (const v of vendors?.vendors || []) {
    const p = (v.vendorId && byVendorId.get(v.vendorId)) || byName.get(normName(v.vendor)) || null;
    if (p) seen.add(p.vendorId);
    const so = outlookBy.get(v.vendorId || normName(v.vendor));
    const disputed = r2(v.disputed + (disputedByVendor.get(v.vendorId || normName(v.vendor)) || 0));
    rows.push([v.vendor, termsText(p), p ? (p.statementAccount ? "Yes" : "No") : "", p?.blockAfterDaysOverdue ?? "", p?.safeDaysOverdue ?? "", p?.pressure ?? "", p ? (p.onHold ? "Yes" : "No") : "", p?.paymentMethods?.join(", ") ?? "", v.bills, v.overdue, disputed, ukDate(v.nextDue), ukDate(so?.payFriday ?? null), so?.blockRisk ? "YES" : "", [p?.proformaOnly ? "Pro-forma only." : "", p?.notes || ""].filter(Boolean).join(" ")]);
  }
  for (const p of profiles) {
    if (seen.has(p.vendorId)) continue;
    rows.push([p.vendorName, termsText(p), p.statementAccount ? "Yes" : "No", p.blockAfterDaysOverdue ?? "", p.safeDaysOverdue ?? "", p.pressure, p.onHold ? "Yes" : "No", p.paymentMethods.join(", "), 0, 0, disputedByVendor.get(p.vendorId) || 0, "", "", "", [p.proformaOnly ? "Pro-forma only." : "", p.notes].filter(Boolean).join(" ")]);
  }
  rows.sort((a, b) => Number(b[8]) - Number(a[8]) || String(a[0]).localeCompare(String(b[0])));
  rows.forEach((row, i) => { g.row(1 + i, row); if (row[13] === "YES") colours.push({ r: 1 + i, c: 13, colour: "red" }); });
  g.row(rows.length + 2, [`Source: QuickBooks Vendor Balance Detail (${vendors ? `as of ${ukDate(vendors.asOf)}` : "unavailable"}) + supplier playbook + dispute register (${disputes.length} active).`]);
  return finish(TAB.suppliers, g.matrix(), { colours });
}

// -------------------------------------------------------------- P&L by Month
const PNL_MONTH_HEADER: Cell[] = ["Month", "Income", "Gross Profit", "Net profit", "No of Deals", "Av Gross Profit", "GP %", "Av Net Profit", "NP %", "AOV"];
function pnlMonthBlock(g: Grid, r0: number, rep: Pick<MonthlyPnlReport, "year" | "months" | "total">, bold: number[], title?: string) {
  bold.push(r0, r0 + 1, r0 + 14);
  g.row(r0, [title || String(rep.year)]);
  g.row(r0 + 1, PNL_MONTH_HEADER);
  rep.months.forEach((m, i) => g.row(r0 + 2 + i, [m.label, m.income, m.grossProfit, m.netProfit, m.deals, m.avgGross, m.gpPct, m.avgNet, m.npPct, m.aov]));
  const t = rep.total;
  g.row(r0 + 14, ["Total", t.income, t.grossProfit, t.netProfit, t.deals, t.avgGross, t.gpPct, t.avgNet, t.npPct, t.aov]);
  const active = rep.months.filter((m) => m.income !== 0 || m.deals > 0);
  const n = active.length || 1;
  g.row(r0 + 15, ["Average / month", r2(t.income / n), r2(t.grossProfit / n), r2(t.netProfit / n), r2(t.deals / n), t.avgGross, t.gpPct, t.avgNet, t.npPct, t.aov]);
  return r0 + 16;
}
export function pnlMonthMatrix(cur: MonthlyPnlReport, prev: MonthlyPnlReport | null): ReportTab {
  const g = new Grid();
  const bold = [0];
  g.row(0, [`P&L by Month — ${cur.year}${prev ? ` vs ${prev.year}` : ""}`]);
  g.row(1, ["Source: QuickBooks Profit and Loss summarised by month (accrual). Deals = projects completed in the month. GP% / NP% of income; AOV = income ÷ deals."]);
  let r = pnlMonthBlock(g, 3, cur, bold);
  if (prev) r = pnlMonthBlock(g, r + 1, prev, bold);
  // The bookkeeper's method: P&L of the projects completed in each month (per class).
  const dStart = r + 2;
  g.row(dStart - 1, [`Delivered projects ${cur.year} — sum of each completed project's P&L by Class (CRM completion dates; months without recorded completions show 0)`]);
  pnlMonthBlock(g, dStart, { year: cur.year, months: cur.delivered || [], total: cur.deliveredTotal || cur.total }, bold, `${cur.year} — delivered projects`);
  return finish(TAB.pnlMonth, g.matrix(), { boldRows: bold });
}

// -------------------------------------------------------------- P&L by Class
export function classPnlMatrix(rep: MonthClassPnl): ReportTab {
  const g = new Grid();
  const projects = rep.designers.flatMap((d) => d.projects.map((p) => ({ ...p, designerGroup: d.designer })));
  g.row(0, [`Profit and Loss by Class — projects completed ${rep.label}`]);
  g.row(1, [`Source: QuickBooks Profit and Loss filtered per class (customer), all dates, accrual. ${projects.length} projects, ${rep.unmatched} without a matched class. Column pairs: amount | % of income. TOTAL = matched projects only.`]);
  const DES = 2, PROJ = 3, HDR = 4, FIRST = 5;
  g.set(DES, 0, "Designer"); g.set(PROJ, 0, "Project / class"); g.set(HDR, 0, "");
  let c = 1;
  const colOf: number[] = [];
  let lastDesigner = "";
  for (const p of projects) {
    if (p.designerGroup !== lastDesigner) { g.set(DES, c, p.designerGroup); lastDesigner = p.designerGroup; }
    g.set(PROJ, c, p.className ? `${p.client}${p.className !== p.client ? ` (${p.className})` : ""}` : `${p.client} — no class`);
    g.row(HDR, ["All Dates", "% of Income"], c);
    colOf.push(c); c += 2;
  }
  const TOTAL = c;
  g.set(DES, TOTAL, "TOTAL"); g.set(PROJ, TOTAL, `${projects.filter((p) => p.pnl).length} matched projects`); g.row(HDR, ["All Dates", "% of Income"], TOTAL);
  const totalIncome = rep.total.income;
  const bold = [0, DES, PROJ, HDR];
  rep.rowOrder.forEach((row, i) => {
    const r = FIRST + i;
    if (row.kind === "summary") bold.push(r);
    g.set(r, 0, `${"   ".repeat(row.depth)}${row.label}`);
    let total = 0; let any = false;
    projects.forEach((p, j) => {
      const hit = p.pnl?.rows.find((x) => x.label === row.label && x.kind === row.kind);
      if (!hit || row.kind === "header") return;
      g.set(r, colOf[j], hit.amount); g.set(r, colOf[j] + 1, hit.pctOfIncome);
      total = r2(total + hit.amount); any = true;
    });
    if (any && row.kind !== "header") { g.set(r, TOTAL, total); g.set(r, TOTAL + 1, totalIncome > 0 ? r2((total / totalIncome) * 100) : null); }
  });
  let r = FIRST + rep.rowOrder.length + 1;
  g.row(r++, ["Completion date", ...projects.flatMap((p) => [ukDate(p.completionDate), p.completionSource === "fallback" ? "inferred" : ""])]);
  g.row(r++, ["Final invoice", ...projects.flatMap((p) => [p.hasFinalInvoice ? "Yes" : "No", ""])]);
  const errors = projects.filter((p) => p.error);
  if (errors.length) { r++; g.row(r++, ["Unmatched / errors"]); for (const p of errors) g.row(r++, [`${p.client}: ${p.error}`]); }
  return finish(TAB.pnlClass, g.matrix(), { boldRows: bold, note: `${rep.label}: ${projects.length} projects` });
}

// ------------------------------------------------------------- Commission
export function commissionMatrix(statements: CommissionStatement[], cfg: DesignerCommission): ReportTab {
  const g = new Grid();
  const bold = [0];
  g.row(0, [commissionTab(cfg.displayName)]);
  g.row(1, [cfg.tiers ? `Split: ${cfg.split.now}% payable now / ${cfg.split.later}% ${cfg.laterRule || "later"}${cfg.minSalesPerMonth ? ` · minimum ${cfg.minSalesPerMonth} sales per month` : ""}. Profit = Net Operating Income of the QuickBooks P&L by class; CRM completion P&L where flagged.` : `Commission structure not supplied — profit shown only. ${cfg.notes}`]);
  // Tier table top right (J:K)
  g.row(0, ["Profit % from", "Comm %"], 9);
  (cfg.tiers || []).forEach(([from, comm], i) => g.row(1 + i, [from, comm], 9));
  if (!cfg.tiers) g.row(1, ["(unknown)", ""], 9);
  let r = 3;
  for (const s of statements) {
    bold.push(r); g.row(r++, [`${s.label} Comm`]);
    bold.push(r); g.row(r++, ["Name / Client", "Profit amount", "Profit %", "Comm %", "Comm amount", `${cfg.split.now}% Comm payable now`, `${cfg.split.later}% Payable later`, "Payable later (date)", "Holds / source"]);
    for (const p of s.projects) {
      const flags = [...p.holds.map((h) => h.replace(/_/g, " ")), p.source === "crm" ? "source: CRM completion P&L" : ""].filter(Boolean).join("; ");
      g.row(r++, [p.client, p.profit, p.profitPct, p.commPct, p.commission, p.payableNow, p.payableLater, ukDate(p.payableLaterDate), flags]);
    }
    if (!s.projects.length) g.row(r++, ["(no projects completed this month)"]);
    bold.push(r); g.row(r++, ["Total", s.totals.profit, s.totals.profitPct, null, s.totals.commission, s.totals.payableNow, s.totals.payableLater, "", s.totals.withHolds ? `${s.totals.withHolds} project(s) with holds` : ""]);
    const gate = s.minSalesGate.required != null ? ` · Min sales gate: ${s.minSalesGate.achieved}/${s.minSalesGate.required} ${s.minSalesGate.met ? "met" : "NOT met"}` : "";
    g.row(r++, [cfg.tiers ? `on payroll: ${cfg.split.now}% in the next payroll run; ${cfg.split.later}% ${cfg.laterRule}${gate}` : `on payroll: commission rule pending (profit only)${gate}`]);
    r++;
  }
  return finish(commissionTab(cfg.displayName), g.matrix(), { boldRows: bold, note: statements.map((s) => s.month).join(", ") });
}

// -------------------------------------------------------------------- Loans
export function loansMatrix(commitments: Commitment[], today: string): ReportTab {
  const g = new Grid();
  const bold = [0];
  g.row(0, ["Name", "Balance", "Loan finish date", "Monthly payment", "Frequency", "Due day", "Next due", "Notes"]);
  const loans = commitments.filter((c) => c.kind === "loan");
  loans.forEach((c, i) => g.row(1 + i, [c.name, c.balance, ukDate(c.endDate), c.amount, c.frequency, c.dueDay, ukDate(commitmentDates(c, today, shiftDays(today, 400))[0] || null), c.notes]));
  bold.push(1 + loans.length);
  g.row(1 + loans.length, ["Total", r2(loans.reduce((s, c) => s + (c.balance || 0), 0)), "", r2(loans.filter((c) => c.frequency === "monthly").reduce((s, c) => s + c.amount, 0))]);
  const others = commitments.filter((c) => c.kind !== "loan");
  if (others.length) {
    let r = 3 + loans.length;
    bold.push(r); g.row(r++, ["Other standing commitments"]);
    bold.push(r); g.row(r++, ["Name", "Kind", "", "Amount", "Frequency", "Due day", "Next due", "Notes"]);
    for (const c of others) g.row(r++, [c.name, c.kind, "", c.amount, c.frequency, c.dueDay, ukDate(commitmentDates(c, today, shiftDays(today, 400))[0] || null), c.notes]);
  }
  return finish(TAB.loans, g.matrix(), { boldRows: bold });
}

// ------------------------------------------------------------- Cash Control
export function cashControlMatrix(entries: CashEntry[]): ReportTab {
  const rows = entries.filter((e) => (e.section === "other_in" || e.section === "other_out") && (e.source === "owner" || e.source === "agent"));
  const g = new Grid();
  g.row(0, ["Date", "Ref", "Info from", "Out", "In", "Balance", "Comment"]);
  let bal = 0;
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt)).forEach((e, i) => {
    const out = e.section === "other_out" ? e.amount : null, inn = e.section === "other_in" ? e.amount : null;
    bal = r2(bal + (inn || 0) - (out || 0));
    g.row(1 + i, [ukDate(e.date), e.id, `${e.label} (${e.source}: ${e.createdBy})`, out, inn, bal, [e.note || "", e.confirmed ? "confirmed" : "expected"].filter(Boolean).join(" · ")]);
  });
  if (!rows.length) g.row(1, ["(no owner/agent cash entries yet — use append_cashflow_entry with section other_in / other_out)"]);
  return finish(TAB.cashControl, g.matrix());
}

// ---------------------------------------------------------------- Dashboard
export function dashboardMatrix(outlook: CashflowOutlook, disputes: Dispute[], heldIntake: number | string): ReportTab {
  const g = new Grid();
  g.row(0, ["Finance — Dashboard"]);
  g.row(1, ["Store + QuickBooks projection. Bank = QuickBooks book balance; receipts = project schedules; bills = Vendor Balance Detail; commitments = loans / overheads / payroll / VAT recorded in the finance store."]);
  const kpis: [string, Cell][] = [
    ["Bank (book balance)", outlook.bank.cash],
    ["Credit cards (book balance)", outlook.bank.creditCards],
    ["13-week low point", outlook.position.low?.closing ?? null],
    ["Low point week starting", ukDate(outlook.position.low?.week ?? null)],
    ["Inbound next 30 days (incl. overdue)", outlook.position.in30],
    ["Outbound next 30 days — supplier bills + commitments", outlook.position.out30],
    ["Standing commitments next 90 days", outlook.commitments.total90],
    ["Overdue in (client receipts)", outlook.inbound.buckets.overdue],
    ["Overdue out (supplier bills)", outlook.outbound.overdue],
    ["Disputes (active register)", r2(disputes.reduce((s, d) => s + d.amount, 0))],
    ["Supplier items under review (QuickBooks)", outlook.outbound.underReview],
    ["Unapplied supplier credits/payments", outlook.outbound.unapplied],
    ["Held intake items", heldIntake],
    ["Suppliers at block risk", outlook.outbound.suppliers.filter((s) => s.blockRisk).length],
    ["Last build", new Date().toISOString()],
  ];
  const KPI0 = 3;
  kpis.forEach((k, i) => g.row(KPI0 + i, k));
  // Weekly projection block (D:G) for a chart
  g.row(2, ["Week starting", "Closing", "Inbound", "Outbound + commitments"], 3);
  outlook.weeks.forEach((w, i) => g.row(3 + i, [ukDate(w.start), w.closing, w.inbound, r2(w.outbound + w.commitments)], 3));
  return finish(TAB.dashboard, g.matrix(), { boldRows: [0, 2] });
}

// ------------------------------------------------------------- orchestration
export interface ReportContext {
  today: string;
  outlook: () => Promise<CashflowOutlook>;
  vendors: () => Promise<VendorBalanceReport | null>;
  profiles: () => Promise<SupplierProfile[]>;
  disputes: () => Promise<Dispute[]>;
  commitments: () => Promise<Commitment[]>;
  cashEntries: () => Promise<CashEntry[]>;
  commission: () => Promise<CommissionConfig>;
}
const memo = <T>(fn: () => Promise<T>) => { let p: Promise<T> | null = null; return () => (p ||= fn()); };
export function newReportContext(): ReportContext {
  const today = localDate();
  return {
    today,
    outlook: memo(() => cashflowOutlook()),
    vendors: memo(() => vendorBalanceDetail().catch(() => null)),
    profiles: memo(() => listSupplierProfiles().catch(() => [])),
    disputes: memo(() => listDisputes({ status: "active" }).catch(() => [])),
    commitments: memo(() => listCommitments().catch(() => [])),
    cashEntries: memo(() => listCashEntries(shiftDays(today, -400), shiftDays(today, HORIZON_DAYS + 30)).catch(() => [])),
    commission: memo(() => getCommissionConfig()),
  };
}

export async function reportTabNames(ctx = newReportContext()): Promise<string[]> {
  const cfg = await ctx.commission().catch(() => null);
  const commission = Object.values(cfg?.designers || {}).map((d) => commissionTab(d.displayName));
  return [TAB.dashboard, TAB.cashflow, TAB.suppliers, TAB.pnlMonth, TAB.pnlClass, ...commission, TAB.loans, TAB.cashControl];
}

export interface BuildOptions { year?: number; month?: string; months?: string[] }
// Build one tab by name (case-insensitive; a prefix is enough, "Commission"
// alone means the first configured designer).
export async function buildReportTab(name: string, ctx = newReportContext(), opts: BuildOptions = {}): Promise<ReportTab> {
  const n = name.trim().toLowerCase();
  const is = (t: string) => t.toLowerCase() === n || t.toLowerCase().startsWith(n);
  if (is(TAB.dashboard)) {
    const [outlook, disputes] = await Promise.all([ctx.outlook(), ctx.disputes()]);
    let held: number | string = "n/a";
    try { const rows = await all<{ state?: string }>(financeStore(), company(), "INTAKE#"); held = rows.filter((r) => r.data?.state === "held").length; } catch { /* intake module absent */ }
    return dashboardMatrix(outlook, disputes, held);
  }
  if (is(TAB.cashflow)) {
    const [outlook, vendors, commitments, entries] = await Promise.all([ctx.outlook(), ctx.vendors(), ctx.commitments(), ctx.cashEntries()]);
    const { closingRow: _c, firstDayCol: _f, days: _d, ...tab } = cashflowMatrix({ outlook, vendors, commitments, entries });
    return tab;
  }
  if (is(TAB.suppliers)) {
    const [vendors, profiles, disputes, outlook] = await Promise.all([ctx.vendors(), ctx.profiles(), ctx.disputes(), ctx.outlook().catch(() => null)]);
    return suppliersMatrix(vendors, profiles, disputes, outlook);
  }
  if (is(TAB.pnlMonth)) {
    const year = opts.year || Number(ctx.today.slice(0, 4));
    const [cur, prev] = await Promise.all([monthlyPnl(year), monthlyPnl(year - 1).catch(() => null)]);
    return pnlMonthMatrix(cur, prev);
  }
  if (is(TAB.pnlClass)) {
    const month = opts.month || shiftMonth(ctx.today.slice(0, 7), -1);
    return classPnlMatrix(await classPnlForProjects(month));
  }
  if (is(TAB.loans)) return loansMatrix(await ctx.commitments(), ctx.today);
  if (is(TAB.cashControl)) return cashControlMatrix(await ctx.cashEntries());
  if (n.startsWith("commission")) {
    const cfg = await ctx.commission();
    const designers = Object.values(cfg.designers);
    const wanted = n.replace(/^commission\s*[–-]?\s*/, "");
    const d = designers.find((x) => !wanted || x.displayName.toLowerCase() === wanted || x.key === wanted || x.displayName.toLowerCase().startsWith(wanted)) || designers[0];
    if (!d) return finish(name, [["No designers configured — add one with set_commission_config"]], { error: "COMMISSION_NOT_CONFIGURED" });
    const months = opts.months || commissionMonths(ctx.today.slice(0, 7));
    const statements: CommissionStatement[] = [];
    for (const m of months) statements.push(await commissionStatement({ designer: d.key, month: m }));
    return commissionMatrix(statements, d);
  }
  throw new Error(`Unknown report tab "${name}" — known: ${(await reportTabNames(ctx)).join(", ")}`);
}

// Every tab (or the named ones, prefix match); errors are returned per tab, never thrown.
export async function buildReportTabs(tabs?: string[], ctx = newReportContext(), opts: BuildOptions = {}): Promise<ReportTab[]> {
  const wanted = (tabs || []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const names = await reportTabNames(ctx);
  const pick = (name: string) => !wanted.length || wanted.some((w) => name.toLowerCase() === w || name.toLowerCase().startsWith(w) || (w.startsWith("commission") && name.startsWith("Commission")));
  const out: ReportTab[] = [];
  for (const name of names.filter(pick)) {
    try { out.push(await buildReportTab(name, ctx, opts)); }
    catch (e) { out.push({ ...finish(name, []), error: e instanceof Error ? e.message : String(e) }); }
  }
  return out;
}

// ----------------------------------------------------------------- helpers
export function toCsv(matrix: Cell[][]): string {
  const cell = (v: Cell) => { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return matrix.map((r) => r.map(cell).join(",")).join("\n");
}
export const colName = (n: number) => { let s = ""; let x = n + 1; while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26); } return s; };
const colIndex = (letters: string) => letters.toUpperCase().split("").reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
// Slice a matrix by an A1 range such as "A1:D40" (whole matrix when absent).
export function sliceA1(matrix: Cell[][], range?: string | null): Cell[][] {
  if (!range) return matrix;
  const m = range.replace(/^'?[^!]*'?!/, "").match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!m) return matrix;
  const c0 = colIndex(m[1]), r0 = Number(m[2]) - 1, c1 = m[3] ? colIndex(m[3]) : c0, r1 = m[4] ? Number(m[4]) - 1 : r0;
  return matrix.slice(r0, r1 + 1).map((row) => row.slice(c0, c1 + 1));
}
