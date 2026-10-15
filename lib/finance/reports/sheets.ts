// OPTIONAL Google Sheets mirror of the report tabs. The finance store and
// QuickBooks are the source of truth; the workbook is a projection written as
// plain values (never formulas) so the owner can read it on a phone. Needs
// two environment variables and nothing else:
//   GOOGLE_SERVICE_ACCOUNT_JSON — the service-account key file contents
//   FINANCE_SHEET_ID            — a workbook shared (Editor) with that account
// Without them every function degrades to "not configured" and the in-app
// matrices (reports/tabs.ts) remain the way to read the reports. Idempotent:
// each tab's matrix is hashed against a hidden `_meta` tab so an unchanged
// tab costs no write.
import { createHash } from "node:crypto";
import { FinanceError } from "@/lib/core/domain";
import { buildReportTabs, colName, type Cell, type ReportTab } from "./tabs";

const META = "_meta";
export const workbookUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;
type Sheets = import("googleapis").sheets_v4.Sheets;
type SheetRequest = import("googleapis").sheets_v4.Schema$Request;

export interface SheetsConfig { configured: boolean; spreadsheetId: string | null; serviceAccountEmail: string | null; reason: string | null }
export function sheetsConfig(): SheetsConfig {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  const spreadsheetId = (process.env.FINANCE_SHEET_ID || "").trim() || null;
  if (!raw) return { configured: false, spreadsheetId, serviceAccountEmail: null, reason: "GOOGLE_SERVICE_ACCOUNT_JSON is not set" };
  let email: string | null = null;
  try { email = JSON.parse(raw).client_email || null; } catch { return { configured: false, spreadsheetId, serviceAccountEmail: null, reason: "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON" }; }
  if (!spreadsheetId) return { configured: false, spreadsheetId, serviceAccountEmail: email, reason: "FINANCE_SHEET_ID is not set" };
  return { configured: true, spreadsheetId, serviceAccountEmail: email, reason: null };
}

async function client(): Promise<{ sheets: Sheets; id: string }> {
  const cfg = sheetsConfig();
  if (!cfg.configured || !cfg.spreadsheetId) throw new FinanceError(`SHEETS_NOT_CONFIGURED: ${cfg.reason}`, false, 503);
  const { google } = await import("googleapis");
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON as string), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  return { sheets: google.sheets({ version: "v4", auth }), id: cfg.spreadsheetId };
}

const a1 = (tab: string, r0: number, c0: number, r1?: number, c1?: number) => `'${tab.replace(/'/g, "''")}'!${colName(c0)}${r0 + 1}${r1 != null && c1 != null ? `:${colName(c1)}${r1 + 1}` : ""}`;
const hashOf = (matrix: Cell[][], colours: unknown) => createHash("sha256").update(JSON.stringify([matrix, colours])).digest("hex");
const COLOUR = { green: { red: 0.72, green: 0.88, blue: 0.63 }, red: { red: 0.96, green: 0.64, blue: 0.64 }, yellow: { red: 1, green: 0.95, blue: 0.66 }, white: { red: 1, green: 1, blue: 1 } };

export interface MetaRow { tab: string; hash: string; updatedAt: string; by: string; rows: number; cols: number; rowIndex: number }
interface SheetProps { sheetId: number; title: string; rowCount: number; columnCount: number }

async function sheetProps(sheets: Sheets, id: string): Promise<Map<string, SheetProps>> {
  const res = await sheets.spreadsheets.get({ spreadsheetId: id, fields: "sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))" });
  const map = new Map<string, SheetProps>();
  for (const s of res.data.sheets || []) { const p = s.properties!; map.set(p.title!, { sheetId: p.sheetId!, title: p.title!, rowCount: p.gridProperties?.rowCount || 1000, columnCount: p.gridProperties?.columnCount || 26 }); }
  return map;
}
async function readMeta(sheets: Sheets, id: string): Promise<Map<string, MetaRow>> {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: a1(META, 1, 0, 99, 5), valueRenderOption: "UNFORMATTED_VALUE" }).catch(() => null);
  const map = new Map<string, MetaRow>();
  (res?.data.values || []).forEach((v, i) => { if (v?.[0]) map.set(String(v[0]), { tab: String(v[0]), hash: String(v[1] ?? ""), updatedAt: String(v[2] ?? ""), by: String(v[3] ?? ""), rows: Number(v[4]) || 0, cols: Number(v[5]) || 0, rowIndex: i + 1 }); });
  return map;
}
async function ensureTabs(sheets: Sheets, id: string, wanted: string[]): Promise<Map<string, SheetProps>> {
  let props = await sheetProps(sheets, id);
  const missing = [...wanted, META].filter((t) => !props.has(t));
  if (missing.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title, hidden: title === META, gridProperties: { rowCount: title === "Cashflow" ? 400 : 300, columnCount: title === "Cashflow" ? 100 : 40 } } } })) } });
    props = await sheetProps(sheets, id);
    await sheets.spreadsheets.values.update({ spreadsheetId: id, range: a1(META, 0, 0), valueInputOption: "RAW", requestBody: { values: [["tab", "hash (sha256 of values)", "updatedAt", "by", "rows", "cols"]] } });
  }
  return props;
}

export interface TabResult { tab: string; changed: boolean; rows: number; cols?: number; note?: string; error?: string }

// One batchUpdate (grid growth, bold rows, colours) and one values write
// (data + tail clear + its _meta row). Skips everything when unchanged.
async function writeTab(sheets: Sheets, id: string, props: Map<string, SheetProps>, meta: Map<string, MetaRow>, by: string, tab: ReportTab): Promise<TabResult> {
  const matrix = tab.matrix;
  const cols = matrix.reduce((m, r) => Math.max(m, r.length), 0);
  const hash = hashOf(matrix, tab.colours);
  const prev = meta.get(tab.tab);
  if (prev && prev.hash === hash) return { tab: tab.tab, changed: false, rows: matrix.length, cols, note: tab.note || undefined };
  const p = props.get(tab.tab);
  if (!p) throw new FinanceError(`SHEET_TAB_MISSING: ${tab.tab}`, false, 500);
  const outRows = Math.max(matrix.length, prev?.rows || 0, 1), outCols = Math.max(cols, prev?.cols || 0, 1);
  const padded: Cell[][] = [];
  for (let r = 0; r < outRows; r++) { const row: Cell[] = []; for (let c = 0; c < outCols; c++) { const v = matrix[r]?.[c]; row.push(v == null ? "" : v); } padded.push(row); }
  const reqs: SheetRequest[] = [];
  if (p.rowCount < outRows || p.columnCount < outCols) { reqs.push({ updateSheetProperties: { properties: { sheetId: p.sheetId, gridProperties: { rowCount: Math.max(p.rowCount, outRows + 5), columnCount: Math.max(p.columnCount, outCols + 2) } }, fields: "gridProperties.rowCount,gridProperties.columnCount" } }); p.rowCount = Math.max(p.rowCount, outRows + 5); p.columnCount = Math.max(p.columnCount, outCols + 2); }
  reqs.push({ repeatCell: { range: { sheetId: p.sheetId, startRowIndex: 0, endRowIndex: outRows, startColumnIndex: 0, endColumnIndex: outCols }, cell: { userEnteredFormat: { backgroundColor: COLOUR.white, textFormat: { bold: false } } }, fields: "userEnteredFormat.backgroundColor,userEnteredFormat.textFormat.bold" } });
  for (const r of tab.boldRows) reqs.push({ repeatCell: { range: { sheetId: p.sheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 0, endColumnIndex: outCols }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } });
  for (const x of tab.colours.slice(0, 900)) reqs.push({ repeatCell: { range: { sheetId: p.sheetId, startRowIndex: x.r, endRowIndex: x.r + 1, startColumnIndex: x.c, endColumnIndex: x.c + 1 }, cell: { userEnteredFormat: { backgroundColor: COLOUR[x.colour] } }, fields: "userEnteredFormat.backgroundColor" } });
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: reqs } });
  const now = new Date().toISOString();
  const rowIndex = prev?.rowIndex ?? (Math.max(0, ...Array.from(meta.values()).map((m) => m.rowIndex)) + 1);
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: id, requestBody: { valueInputOption: "RAW", data: [
    { range: a1(tab.tab, 0, 0), values: padded },
    { range: a1(META, rowIndex, 0), values: [[tab.tab, hash, now, by, matrix.length, cols]] },
  ] } });
  meta.set(tab.tab, { tab: tab.tab, hash, updatedAt: now, by, rows: matrix.length, cols, rowIndex });
  return { tab: tab.tab, changed: true, rows: matrix.length, cols, note: tab.note || undefined };
}

export interface SyncResult { configured: boolean; spreadsheetId: string | null; url: string | null; results: TabResult[]; note?: string }
export async function syncFinanceSheets(input: { tabs?: string[]; by: string }): Promise<SyncResult> {
  const cfg = sheetsConfig();
  if (!cfg.configured) return { configured: false, spreadsheetId: cfg.spreadsheetId, url: null, results: [], note: `Google Sheets not configured (${cfg.reason}). The report tabs are still available in-app: GET /api/finance/reports?tab=… or get_sheet_tab.` };
  const { sheets, id } = await client();
  const built = await buildReportTabs(input.tabs);
  const props = await ensureTabs(sheets, id, built.map((t) => t.tab));
  const meta = await readMeta(sheets, id);
  const results: TabResult[] = [];
  for (const tab of built) {
    if (tab.error) { results.push({ tab: tab.tab, changed: false, rows: 0, error: tab.error }); continue; }
    try { results.push(await writeTab(sheets, id, props, meta, input.by, tab)); }
    catch (e) { results.push({ tab: tab.tab, changed: false, rows: 0, error: e instanceof Error ? e.message : String(e) }); }
  }
  return { configured: true, spreadsheetId: id, url: workbookUrl(id), results };
}

export async function readSheetTab(tab: string, range?: string): Promise<{ tab: string; range: string; values: Cell[][] }> {
  const { sheets, id } = await client();
  const safeTab = tab.replace(/'/g, "''");
  const a1Range = range ? `'${safeTab}'!${range.replace(/^'?[^!]*'?!/, "")}` : `'${safeTab}'`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: a1Range, valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "FORMATTED_STRING" });
  return { tab, range: res.data.range || a1Range, values: (res.data.values || []) as Cell[][] };
}

export async function sheetsStatus(): Promise<SheetsConfig & { url: string | null; meta: Omit<MetaRow, "rowIndex">[] }> {
  const cfg = sheetsConfig();
  if (!cfg.configured || !cfg.spreadsheetId) return { ...cfg, url: cfg.spreadsheetId ? workbookUrl(cfg.spreadsheetId) : null, meta: [] };
  try {
    const { sheets, id } = await client();
    const meta = await readMeta(sheets, id);
    return { ...cfg, url: workbookUrl(id), meta: Array.from(meta.values()).map(({ rowIndex: _r, ...m }) => m) };
  } catch (e) {
    return { ...cfg, configured: false, reason: e instanceof Error ? e.message : String(e), url: workbookUrl(cfg.spreadsheetId), meta: [] };
  }
}
