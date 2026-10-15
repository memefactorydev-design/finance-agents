import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { buildFinanceOverview, slimOverview } from "@/lib/finance/overview";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/finance/overview?slim=1&includeCompleted=1&pnlLimit=50 — the
// project money model rolled up: collections, due lines, invoices, the four
// P&Ls. CRM figures, unreconciled to the bank.
export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const u = new URL(request.url);
    const pnlLimit = Number(u.searchParams.get("pnlLimit") || "") || undefined;
    const o = await buildFinanceOverview({ includeCompleted: u.searchParams.get("includeCompleted") === "1", includeCancelled: u.searchParams.get("includeCancelled") === "1", pnlLimit });
    return NextResponse.json(u.searchParams.get("slim") === "1" ? slimOverview(o) : o, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}
