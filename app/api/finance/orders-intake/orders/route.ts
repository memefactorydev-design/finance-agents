// GET /api/finance/orders-intake/orders?supplierId= — open purchase orders an
// acknowledgement can be matched to.
import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { openOrdersForMatching } from "@/lib/finance/orders/orders-intake";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const supplierId = new URL(request.url).searchParams.get("supplierId");
    return NextResponse.json({ orders: await openOrdersForMatching(supplierId && supplierId !== "all" ? supplierId : null) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}
