// POST /api/finance/orders-intake/<sha256>/match {orderId} — attach the
// acknowledgement to a purchase order.
import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { matchOrderAck } from "@/lib/finance/orders/orders-intake";
import { requireSha } from "../../_shared";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function POST(request: Request, { params }: { params: { sha: string } }) {
  try {
    const p = await requirePrincipal(request);
    sameOrigin(request);
    const { orderId } = z.object({ orderId: z.string().min(1) }).parse(await request.json().catch(() => ({})));
    return NextResponse.json({ record: await matchOrderAck(requireSha(params.sha), orderId, actorName(p)) });
  } catch (e) { return financeError(e); }
}
