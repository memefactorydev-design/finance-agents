import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { postingEnabled } from "@/lib/qbo/client";
import { markBillDisputed } from "@/lib/finance/supplier-terms";
import { listDisputes, raiseDispute, type DisputeStatus } from "@/lib/finance/suppliers";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET  /api/finance/disputes?status=active|all|<status>&vendor=…  — the dispute register
// POST /api/finance/disputes {vendor, amount, reason, billId?, docNumber?, project?, …} — raise.
// When billId is given and QuickBooks posting is on, the Bill memo is prefixed
// "[DISPUTED - reason - raised date]"; otherwise the memo step is a dry run.
const STATUSES = ["open", "awaiting_supplier", "credit_expected", "resolved", "withdrawn", "active", "all"] as const;
const EVIDENCE = z.object({ kind: z.enum(["email", "blob", "note", "crm", "statement"]), ref: z.string().min(1), note: z.string().optional() });
const raise = z.object({ billId: z.string().optional(), vendorId: z.string().optional(), vendor: z.string().min(1), docNumber: z.string().optional(), amount: z.number().min(0), classId: z.string().optional(), project: z.string().optional(), projectId: z.string().optional(), reason: z.string().min(5), evidence: z.array(EVIDENCE).optional(), raisedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const u = new URL(request.url);
    const status = (u.searchParams.get("status") || "active") as (typeof STATUSES)[number];
    if (!STATUSES.includes(status)) return NextResponse.json({ error: { code: "STATUS_INVALID", message: `status must be one of ${STATUSES.join(", ")}` } }, { status: 400 });
    const disputes = await listDisputes({ status: status as DisputeStatus | "active" | "all", vendor: u.searchParams.get("vendor") || undefined });
    return NextResponse.json({ status, total: disputes.length, totalAmount: Math.round(disputes.reduce((s, d) => s + d.amount, 0) * 100) / 100, disputes, postingEnabled: await postingEnabled() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}

export async function POST(request: Request) {
  try {
    const p = await requirePrincipal(request);
    sameOrigin(request);
    const b = raise.parse(await request.json());
    const dispute = await raiseDispute({ billId: b.billId ?? null, vendorId: b.vendorId ?? null, vendor: b.vendor, docNumber: b.docNumber ?? null, amount: b.amount, classId: b.classId ?? null, project: b.project ?? null, projectId: b.projectId ?? null, reason: b.reason, evidence: b.evidence || [], raisedAt: b.raisedAt }, actorName(p));
    const qboMemo = dispute.billId ? await markBillDisputed(dispute.billId, b.reason, dispute.raisedAt) : { state: "skipped" as const, detail: "no billId" };
    return NextResponse.json({ dispute, qboMemo }, { status: 201 });
  } catch (e) { return financeError(e); }
}
