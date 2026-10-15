import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { vendorBalanceDetail } from "@/lib/finance/vendor-balances";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/finance/vendor-balances?fresh=1 — QuickBooks Vendor Balance Detail
// parsed into open supplier bills by vendor + due-date buckets. Read-only.
export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const report = await vendorBalanceDetail({ fresh: new URL(request.url).searchParams.get("fresh") === "1" });
    return NextResponse.json(report, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}
