import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { sheetsStatus, syncFinanceSheets } from "@/lib/finance/reports/sheets";
import { buildReportTab, reportTabNames, sliceA1, toCsv } from "@/lib/finance/reports/tabs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET  /api/finance/reports                       — tab names + Google Sheets status
// GET  /api/finance/reports?tab=Cashflow&format=json|csv&range=A1:D40&year=&month=
// POST /api/finance/reports {tabs?}               — rebuild (and mirror to Google Sheets when configured)
export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const u = new URL(request.url);
    const tab = u.searchParams.get("tab");
    if (!tab) return NextResponse.json({ tabs: await reportTabNames(), sheets: await sheetsStatus() }, { headers: { "Cache-Control": "private, no-store" } });
    const t = await buildReportTab(tab, undefined, { year: Number(u.searchParams.get("year")) || undefined, month: u.searchParams.get("month") || undefined });
    if (t.error) return NextResponse.json({ error: { code: "REPORT_FAILED", message: `${t.tab}: ${t.error}` } }, { status: 502 });
    const values = sliceA1(t.matrix, u.searchParams.get("range"));
    if (u.searchParams.get("format") === "csv") return new Response(toCsv(values), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${t.tab.replace(/[^A-Za-z0-9 _-]+/g, "_")}.csv"`, "Cache-Control": "private, no-store" } });
    return NextResponse.json({ tab: t.tab, generatedAt: t.generatedAt, note: t.note, rows: values.length, values, colours: t.colours }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}
export async function POST(request: Request) {
  try {
    const p = await requirePrincipal(request);
    sameOrigin(request);
    const body = z.object({ tabs: z.array(z.string()).max(12).optional() }).parse(await request.json().catch(() => ({})));
    const r = await syncFinanceSheets({ tabs: body.tabs, by: actorName(p) });
    return NextResponse.json({ ...r, ok: r.results.every((x) => !x.error) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}
