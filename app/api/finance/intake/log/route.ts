// GET /api/finance/intake/log?date=YYYY-MM-DD              → CSV (Excel log) for that day (company time zone)
//     /api/finance/intake/log?from=YYYY-MM-DD&to=YYYY-MM-DD → CSV for the inclusive range
//     &format=json                                          → { window, posting, rows, totals } instead
// Defaults to today.
import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/core/auth";
import { getConnections } from "@/lib/core/config";
import { FinanceError } from "@/lib/core/domain";
import { financeError } from "@/lib/core/server";
import { buildIntakeLog, intakeLogCsv, intakeLogFileName } from "@/lib/finance/intake/log";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const q = new URL(request.url).searchParams;
    const date = q.get("date") || undefined, from = q.get("from") || undefined, to = q.get("to") || undefined;
    for (const v of [date, from, to]) if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new FinanceError("DATE_INVALID", false, 422);
    const log = await buildIntakeLog({ date, from, to: to || from });
    if (q.get("format") === "json") return NextResponse.json({ window: log.window, posting: log.posting, rows: log.rows, totals: log.totals }, { headers: { "Cache-Control": "private, no-store" } });
    const cfg = await getConnections();
    const csv = intakeLogCsv(log.rows, cfg.company.timezone);
    return new NextResponse(csv, { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${intakeLogFileName(log.window)}"`, "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}
