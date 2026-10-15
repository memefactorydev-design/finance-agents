// Scheduled job for the reports: rebuild every tab (which warms the
// cashflow, vendor-balance and P&L caches) and, when Google Sheets is
// configured, mirror the changed tabs to the workbook. Per-tab errors are
// collected, never thrown. Params: tabs=Cashflow,Dashboard to limit.
import { buildReportTabs } from "./tabs";
import { sheetsConfig, syncFinanceSheets } from "./sheets";

type Handler = (params: Record<string, string>) => Promise<unknown>;

export const reportsJob: Handler = async (params) => {
  const started = Date.now();
  const tabs = params.tabs ? params.tabs.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  if (sheetsConfig().configured) {
    const r = await syncFinanceSheets({ tabs, by: "cron" });
    const errors = r.results.filter((x) => x.error).map((x) => ({ tab: x.tab, error: x.error! }));
    return { healthy: errors.length === 0, sheets: true, url: r.url, changed: r.results.filter((x) => x.changed).map((x) => x.tab), unchanged: r.results.filter((x) => !x.changed && !x.error).map((x) => x.tab), errors, ms: Date.now() - started };
  }
  const built = await buildReportTabs(tabs);
  const errors = built.filter((t) => t.error).map((t) => ({ tab: t.tab, error: t.error! }));
  return { healthy: errors.length === 0, sheets: false, built: built.filter((t) => !t.error).map((t) => ({ tab: t.tab, rows: t.matrix.length })), errors, ms: Date.now() - started };
};
