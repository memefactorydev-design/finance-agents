// GET /api/finance/orders-intake/<sha256> — one acknowledgement record.
import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { getOrderAck } from "@/lib/finance/orders/orders-intake";
import { requireSha } from "../_shared";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { sha: string } }) {
  try {
    await requirePrincipal(request);
    const record = await getOrderAck(requireSha(params.sha));
    if (!record) return NextResponse.json({ error: { code: "ORDERACK_NOT_FOUND" } }, { status: 404 });
    return NextResponse.json({ record }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}
