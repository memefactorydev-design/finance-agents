// GET /api/finance/orders-intake/<sha256>/evidence — the stored document
// inline: the PDF, or the plain-text email body.
import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { readOrderAckEvidence } from "@/lib/finance/orders/orders-intake";
import { evidenceResponse, requireSha } from "../../_shared";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { sha: string } }) {
  try {
    await requirePrincipal(request);
    const file = await readOrderAckEvidence(requireSha(params.sha));
    if (!file) return NextResponse.json({ error: { code: "ORDERACK_NOT_FOUND" } }, { status: 404 });
    return evidenceResponse(file);
  } catch (e) { return financeError(e); }
}
