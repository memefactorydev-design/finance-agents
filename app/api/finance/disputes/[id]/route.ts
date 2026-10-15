import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { updateDispute } from "@/lib/finance/suppliers";
export const dynamic = "force-dynamic";

// PATCH /api/finance/disputes/<id> {status?, note?, outcome?, amount?, evidence?}
// Resolving / withdrawing stamps resolvedAt + clockRestartAt (the payment clock restarts).
const patch = z.object({
  status: z.enum(["open", "awaiting_supplier", "credit_expected", "resolved", "withdrawn"]).optional(),
  note: z.string().optional(), outcome: z.string().optional(), amount: z.number().min(0).optional(),
  evidence: z.array(z.object({ kind: z.enum(["email", "blob", "note", "crm", "statement"]), ref: z.string().min(1), note: z.string().optional() })).optional(),
});
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const p = await requirePrincipal(request);
    sameOrigin(request);
    const b = patch.parse(await request.json());
    if (!b.status && !b.note?.trim() && !b.outcome?.trim() && b.amount === undefined && !b.evidence?.length) return NextResponse.json({ error: { code: "NOTHING_TO_UPDATE", message: "Give status, note, outcome, amount or evidence" } }, { status: 400 });
    const dispute = await updateDispute(decodeURIComponent(params.id), { status: b.status, note: b.note?.trim() || undefined, outcome: b.outcome?.trim() || undefined, amount: b.amount, evidence: b.evidence }, actorName(p));
    return NextResponse.json({ dispute });
  } catch (e) { return financeError(e); }
}
