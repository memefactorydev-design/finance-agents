// GET /api/finance/intake/decisions?vendor=&vendorId=&since=&action=&limit=
//   → { decisions: CodingDecision[], stats: DecisionStats } (learning-loop history for Finance ▸ Supplier invoices ▸ Decisions)
import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/core/auth";
import { FinanceError } from "@/lib/core/domain";
import { financeError } from "@/lib/core/server";
import { listDecisions, decisionStats, type DecisionAction } from "@/lib/finance/intake/learning";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS: DecisionAction[] = ["post", "hold", "reject", "reprocess", "edit_posted", "promote", "demote"];

export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const q = new URL(request.url).searchParams;
    const action = q.get("action") as DecisionAction | null;
    if (action && !ACTIONS.includes(action)) throw new FinanceError("ACTION_INVALID", false, 422);
    const limit = Math.max(1, Math.min(parseInt(q.get("limit") || "200", 10) || 200, 1000));
    const since = q.get("since") || undefined;
    const [decisions, stats] = await Promise.all([
      listDecisions({ vendor: q.get("vendor") || undefined, vendorId: q.get("vendorId") || undefined, since, action: action || undefined, limit }),
      decisionStats({ since }),
    ]);
    return NextResponse.json({ decisions, stats }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}
