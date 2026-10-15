// POST /api/finance/orders-intake/<sha256>/reject {reason} — mark an intake
// item as not relevant (never one already applied to an order).
import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { rejectOrderAck } from "@/lib/finance/orders/orders-intake";
import { requireSha } from "../../_shared";
export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: { sha: string } }) {
  try {
    const p = await requirePrincipal(request);
    sameOrigin(request);
    const { reason } = z.object({ reason: z.string().trim().min(2).max(200) }).parse(await request.json().catch(() => ({})));
    return NextResponse.json({ record: await rejectOrderAck(requireSha(params.sha), reason, actorName(p)) });
  } catch (e) { return financeError(e); }
}
