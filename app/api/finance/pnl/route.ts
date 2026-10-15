import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { localDate } from "@/lib/core/text";
import { requireProject } from "@/lib/crm/projects";
import { projectName } from "@/lib/crm/types";
import { classPnl, classPnlByCustomer, classPnlForProjects, monthlyPnl } from "@/lib/finance/qbo-pnl";
import { projectPnl } from "@/lib/finance/project-pnl";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// GET /api/finance/pnl?projectId=…        — the four P&Ls of one project (CRM + ledger)
// GET /api/finance/pnl?year=2026          — QuickBooks P&L by month (+ delivered-projects view)
// GET /api/finance/pnl?month=2026-09      — P&L by class for every project completed that month
// GET /api/finance/pnl?classId=… | ?customer=…  — one class, optional start/end
// &fresh=1 bypasses the report caches. Read-only against QuickBooks.
export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const u = new URL(request.url), q = (k: string) => u.searchParams.get(k) || undefined;
    const fresh = q("fresh") === "1";
    const headers = { "Cache-Control": "private, no-store" };
    if (q("projectId")) { const p = await requireProject(q("projectId")!); return NextResponse.json({ projectId: p.id, client: projectName(p), netValue: p.wonValue || 0, ...(await projectPnl(p)), costing: p.costing ?? null }, { headers }); }
    if (q("month")) return NextResponse.json(await classPnlForProjects(q("month")!, { fresh, designer: q("designer") }), { headers });
    if (q("classId")) return NextResponse.json(await classPnl(q("classId")!, { start: q("start"), end: q("end"), fresh }), { headers });
    if (q("customer")) return NextResponse.json(await classPnlByCustomer(q("customer")!, { start: q("start"), end: q("end") }), { headers });
    return NextResponse.json(await monthlyPnl(Number(q("year")) || Number(localDate().slice(0, 4)), { fresh }), { headers });
  } catch (e) { return financeError(e); }
}
