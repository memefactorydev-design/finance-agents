// Report, P&L and commission tools for the agents (cashflow keeper, P&L and
// commission, reports keeper). The report tabs are built in-app from the
// finance store and QuickBooks; Google Sheets is an optional mirror. Manual
// cash rows go through CASH_ENTRY# records so they survive every rebuild.
// Nothing here pays anyone.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { actorName, fail, ok, principalFrom, runTool, type Extra } from "./auth";
import { localDate } from "@/lib/core/text";
import { commissionStatement, getCommissionConfig, setCommissionConfig } from "@/lib/finance/commission";
import { classPnl, classPnlByCustomer, classPnlForProjects, monthlyPnl } from "@/lib/finance/qbo-pnl";
import { readSheetTab, sheetsStatus, syncFinanceSheets } from "@/lib/finance/reports/sheets";
import { buildReportTab, reportTabNames, sliceA1 } from "@/lib/finance/reports/tabs";
import { appendCashEntry, CASH_SECTIONS, listCommitments, upsertCommitment, type CashSection } from "@/lib/finance/suppliers";

const adminOnly = (p: { role: string }) => (p.role === "admin" ? null : "Forbidden: this tool needs an admin API key");
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const MONTH = z.string().regex(/^\d{4}-\d{2}$/, "YYYY-MM");
const SECTIONS = CASH_SECTIONS as [CashSection, ...CashSection[]];

export function registerReportTools(server: McpServer) {
  server.registerTool("sync_finance_sheets", { title: "Rebuild the finance report tabs (and mirror to Google Sheets when configured)", description: "Rebuild the report tabs from the finance store and QuickBooks: Cashflow (90-day daily forecast, colour-coded), Suppliers, P&L by Month, P&L by Class, Commission per designer, Loans, Cash Control, Dashboard. When GOOGLE_SERVICE_ACCOUNT_JSON + FINANCE_SHEET_ID are set the tabs are written to the workbook (idempotent — unchanged tabs are skipped); otherwise the result says 'not configured' and the tabs remain readable with get_sheet_tab. Pass tabs to limit, e.g. ['Cashflow','Dashboard']. Errors are reported per tab, not thrown.", inputSchema: { tabs: z.array(z.string()).max(12).optional().describe("Tab names (prefix match, case-insensitive). Omit for a full sync.") }, annotations: { readOnlyHint: false, destructiveHint: false } },
    async (a, extra: Extra) => runTool(async () => {
      const p = principalFrom(extra.authInfo);
      const r = await syncFinanceSheets({ tabs: a.tabs, by: actorName(p) });
      if (!r.configured) return ok({ configured: false, note: r.note, tabs: await reportTabNames() });
      return ok({ configured: true, url: r.url, changed: r.results.filter((x) => x.changed).map((x) => x.tab), unchanged: r.results.filter((x) => !x.changed && !x.error).map((x) => x.tab), errors: r.results.filter((x) => x.error).map((x) => ({ tab: x.tab, error: x.error })), results: r.results });
    }));

  server.registerTool("get_sheet_tab", { title: "Read a finance report tab", description: "The value matrix of one report tab, built in-app (numbers as numbers): Dashboard, Cashflow, Suppliers, P&L by Month, P&L by Class, Commission – <designer>, Loans, Cash Control. Optional A1 range within the tab, e.g. 'A1:D40'. source='sheet' reads the live Google Sheets copy instead (only when configured) — use it for read-back verification after a sync.", inputSchema: { tab: z.string().min(1).max(60), range: z.string().max(40).optional(), source: z.enum(["app", "sheet"]).optional().default("app"), year: z.number().int().optional().describe("P&L by Month: year"), month: MONTH.optional().describe("P&L by Class: month of completions") }, annotations: { readOnlyHint: true } },
    async (a, extra: Extra) => runTool(async () => {
      principalFrom(extra.authInfo);
      if (a.source === "sheet") { const r = await readSheetTab(a.tab, a.range); return ok({ source: "sheet", ...r, rows: r.values.length }); }
      const t = await buildReportTab(a.tab, undefined, { year: a.year, month: a.month });
      if (t.error) return fail(`${t.tab}: ${t.error}`);
      const values = sliceA1(t.matrix, a.range);
      return ok({ source: "app", tab: t.tab, range: a.range || null, generatedAt: t.generatedAt, note: t.note, rows: values.length, values });
    }));

  server.registerTool("append_cashflow_entry", { title: "Add a cashflow entry", description: "Record a manual cash line that the Cashflow tab (and Cash Control for other_in/other_out) shows on its date: a confirmed receipt, an expected merchant/finance payout, a payment approved for this Friday (section 'supplier', confirmed=true → green), an owner-entered item. Stored as a CASH_ENTRY# record so it survives every rebuild. amount is positive; the section gives the direction (inflows: deposit, survey, final, merchant, finance, other_in; outflows: supplier, overhead, loan, wages, vat, other_out).", inputSchema: { date: ISO_DATE, section: z.enum(SECTIONS), label: z.string().min(1).max(120).describe("Customer / supplier / description — supplier entries should use the QuickBooks vendor name so they land on that supplier's row"), amount: z.number().positive(), note: z.string().max(300).optional(), confirmed: z.boolean().optional().default(false).describe("true = money moved / payment approved (green); false = expected") }, annotations: { readOnlyHint: false, destructiveHint: false } },
    async (a, extra: Extra) => runTool(async () => {
      const p = principalFrom(extra.authInfo);
      const e = await appendCashEntry({ date: a.date, section: a.section, label: a.label, amount: a.amount, note: a.note ?? null, source: "agent", confirmed: a.confirmed }, actorName(p));
      return ok({ entry: e, next: "Run sync_finance_sheets(['Cashflow','Cash Control']) or read get_sheet_tab('Cashflow') to see it projected." });
    }));

  server.registerTool("get_commission_statement", { title: "Designer commission statement", description: "Commission statement for one designer and month: every project completed in the month with profit (Net Operating Income from the QuickBooks P&L by class; CRM completion P&L fallback flagged source:'crm'), profit %, tier %, commission, payable-now / payable-later split with dates, holds (no final invoice, remedials open, below lowest tier, class not matched), totals and the minimum-sales gate. Tiers come from CONFIG#commission (set_commission_config); a designer without tiers gets profit only. Preparation only — the owner approves.", inputSchema: { designer: z.string().min(1).max(40).describe("Designer key, display name or a name fragment as configured"), month: MONTH, fresh: z.boolean().optional().describe("Bypass the per-class report cache") }, annotations: { readOnlyHint: true } },
    async (a, extra: Extra) => runTool(async () => { principalFrom(extra.authInfo); return ok(await commissionStatement({ designer: a.designer, month: a.month, fresh: a.fresh })); }));

  server.registerTool("get_monthly_pnl", { title: "Monthly P&L (QuickBooks)", description: "QuickBooks Profit and Loss summarised by month for a year (accrual): income, COGS, gross profit, expenses, net profit, number of deals completed (CRM completion dates), average GP / NP per deal, GP %, NP %, AOV, the year total, plus the 'delivered projects' view (sum of per-class P&Ls of the projects completed in each month).", inputSchema: { year: z.number().int().min(2000).max(2100).optional().describe("Defaults to the current year"), fresh: z.boolean().optional() }, annotations: { readOnlyHint: true } },
    async (a, extra: Extra) => runTool(async () => { principalFrom(extra.authInfo); return ok(await monthlyPnl(a.year || Number(localDate().slice(0, 4)), { fresh: a.fresh })); }));

  server.registerTool("get_class_pnl", { title: "P&L by class (project)", description: "QuickBooks Profit and Loss filtered to one class (= one customer project) with the exact QuickBooks row set and % of income. Give classId or customer (name match against the class list; ambiguous names are refused with the candidates). Or give month (YYYY-MM) to get every project completed that month grouped by designer.", inputSchema: { classId: z.string().optional(), customer: z.string().optional().describe("Customer / class name"), month: MONTH.optional().describe("All projects completed in this month, grouped by designer"), start: ISO_DATE.optional().describe("Defaults to all dates"), end: ISO_DATE.optional(), fresh: z.boolean().optional() }, annotations: { readOnlyHint: true } },
    async (a, extra: Extra) => runTool(async () => {
      principalFrom(extra.authInfo);
      if (a.month) { const r = await classPnlForProjects(a.month, { fresh: a.fresh }); return ok({ ...r, designers: r.designers.map((d) => ({ ...d, projects: d.projects.map(({ pnl, ...rest }) => ({ ...rest, summary: pnl?.summary || null, rows: pnl?.rows || null })) })) }); }
      if (a.classId) return ok(await classPnl(a.classId, { start: a.start, end: a.end, fresh: a.fresh }));
      if (a.customer) return ok(await classPnlByCustomer(a.customer, { start: a.start, end: a.end }));
      return fail("Give classId, customer or month");
    }));

  server.registerTool("list_commitments", { title: "Standing commitments", description: "Loans, overheads, payroll, tax (VAT) and card commitments with amount, frequency, due day, next due, balance and end date — the Loans tab and the committed outflows in the cashflow.", inputSchema: { kind: z.enum(["loan", "overhead", "payroll", "tax", "card"]).optional() }, annotations: { readOnlyHint: true } },
    async (a, extra: Extra) => runTool(async () => { principalFrom(extra.authInfo); const rows = (await listCommitments()).filter((c) => !a.kind || c.kind === a.kind); return ok({ total: rows.length, commitments: rows }); }));

  server.registerTool("upsert_commitment", { title: "Add or update a standing commitment", description: "Admin keys. Record or change a loan / overhead / payroll / tax / card commitment (amount per occurrence, frequency, due day of month or ISO weekday for weekly, loan balance, end date). Give id to update an existing row; omit to create (id derived from kind + name). active=false retires it.", inputSchema: { id: z.string().optional(), kind: z.enum(["loan", "overhead", "payroll", "tax", "card"]), name: z.string().min(1).max(80), amount: z.number().min(0), frequency: z.enum(["weekly", "monthly", "quarterly", "once"]), dueDay: z.number().int().min(1).max(31).nullable().optional(), nextDue: ISO_DATE.nullable().optional(), balance: z.number().nullable().optional(), endDate: ISO_DATE.nullable().optional(), notes: z.string().max(500).optional(), active: z.boolean().optional() }, annotations: { readOnlyHint: false, destructiveHint: false } },
    async (a, extra: Extra) => runTool(async () => { const p = principalFrom(extra.authInfo); const err = adminOnly(p); if (err) return fail(err); return ok({ commitment: await upsertCommitment({ ...a }, actorName(p)) }); }));

  server.registerTool("set_commission_config", { title: "Set a designer's commission structure", description: "Admin keys. Create or update CONFIG#commission for one designer: match fragments (how the CRM names them), tier table as [[profitPctFrom, commPct], …] (floor lookup; below the lowest tier pays 0; null = unknown → profit only), payable split {now, later} summing to 100, minimum sales per month (null = no gate), the later-payment rule text and notes. Omit a field to leave it unchanged. Returns the full config.", inputSchema: { designer: z.string().min(1).max(40).describe("Short key, e.g. the designer's first name"), displayName: z.string().max(40).optional(), match: z.array(z.string().min(1).max(40)).max(5).optional().describe("Name/email fragments identifying the designer in the CRM"), tiers: z.array(z.tuple([z.number().min(0).max(100), z.number().min(0).max(100)])).max(30).nullable().optional(), split: z.object({ now: z.number().min(0).max(100), later: z.number().min(0).max(100) }).optional(), minSalesPerMonth: z.number().int().min(0).nullable().optional(), laterRule: z.string().max(200).optional(), notes: z.string().max(500).optional() }, annotations: { readOnlyHint: false, destructiveHint: false } },
    async (a, extra: Extra) => runTool(async () => { const p = principalFrom(extra.authInfo); const err = adminOnly(p); if (err) return fail(err); const cfg = await setCommissionConfig(a, actorName(p)); return ok({ designers: cfg.designers, updatedBy: cfg.updatedBy, updatedAt: cfg.updatedAt }); }));

  server.registerTool("get_finance_sheets_status", { title: "Finance reports / workbook status", description: "The report tabs available in-app, and — when Google Sheets is configured — the workbook id/URL, the service-account email it must be shared with and the _meta rows (per tab: hash, last updated, by). 'configured: false' with the reason otherwise.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async (_a, extra: Extra) => runTool(async () => {
      principalFrom(extra.authInfo);
      const [status, cfg, tabs] = await Promise.all([sheetsStatus(), getCommissionConfig().catch(() => null), reportTabNames()]);
      return ok({ ...status, tabs, commissionDesigners: cfg ? Object.keys(cfg.designers) : [] });
    }));
}
