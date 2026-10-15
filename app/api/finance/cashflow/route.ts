import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requireAdmin, requirePrincipal } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { cashflowOutlook, setBankAccountHidden } from "@/lib/finance/cashflow";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/finance/cashflow?fresh=1 — bank book balances + expected client
// receipts − live supplier bills − commitments, 13 weeks. Read-only.
export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const report = await cashflowOutlook({ fresh: new URL(request.url).searchParams.get("fresh") === "1" });
    return NextResponse.json(report, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}

// PATCH /api/finance/cashflow { accountId, hidden } — admins hide/show a bank
// or card account the business no longer uses. Hidden accounts stay listed
// but leave the cash figure and the projection.
const patch = z.object({ accountId: z.string().min(1), hidden: z.boolean() });
export async function PATCH(request: Request) {
  try {
    const p = await requirePrincipal(request);
    requireAdmin(p);
    sameOrigin(request);
    const body = patch.parse(await request.json());
    const settings = await setBankAccountHidden(body.accountId.trim(), body.hidden, actorName(p));
    const report = await cashflowOutlook({ fresh: true });
    return NextResponse.json({ settings, report }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}
