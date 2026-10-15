// GET /api/finance/orders-intake/health — per-mailbox reachability, last
// check and watermark for the orders intake.
import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { ordersIntakeHealth } from "@/lib/finance/orders/orders-intake";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { await requirePrincipal(request); return NextResponse.json(await ordersIntakeHealth(), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (e) { return financeError(e); }
}
