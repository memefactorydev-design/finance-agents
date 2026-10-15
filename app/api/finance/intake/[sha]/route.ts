// GET  /api/finance/intake/[sha]          → one intake record, its coding decisions and (for proposed items) the autopilot verdict
//      /api/finance/intake/[sha]?pdf=1    → the PDF itself (inline) from evidence
// POST /api/finance/intake/[sha] {action:"post"|"hold"|"reject"|"reprocess", overrides?, reason?, dryRun?}
//      {action:"edit_posted", changes:{lines?:[{index, accountId?, classId?, taxCodeId?}], dueDate?, docNumber?, privateNote?}}
//        → full-object Bill update in QuickBooks, logged as an edit_posted decision
import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { FinanceError } from "@/lib/core/domain";
import { financeError, sameOrigin } from "@/lib/core/server";
import { postingEnabled } from "@/lib/qbo/client";
import { getIntake, postIntake, holdIntake, rejectIntake, reprocessIntake, editPostedIntake, autopilotVerdict, readIntakePdf } from "@/lib/finance/intake/intake";
import { listDecisions } from "@/lib/finance/intake/learning";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SHA = /^[a-f0-9]{64}$/;
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(request: Request, { params }: { params: { sha: string } }) {
  try {
    await requirePrincipal(request);
    if (!SHA.test(params.sha)) throw new FinanceError("BAD_SHA", false, 400);
    if (new URL(request.url).searchParams.get("pdf") === "1") {
      const pdf = await readIntakePdf(params.sha);
      if (!pdf) throw new FinanceError("INTAKE_NOT_FOUND", false, 404);
      const safeName = pdf.fileName.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "invoice.pdf";
      return new Response(pdf.bytes as BodyInit, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${safeName}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
    }
    const rec = await getIntake(params.sha);
    if (!rec) throw new FinanceError("INTAKE_NOT_FOUND", false, 404);
    const [decisions, autopilot, posting] = await Promise.all([listDecisions({ sha256: params.sha, limit: 50 }).catch(() => []), rec.state === "proposed" ? autopilotVerdict(rec).catch(() => null) : null, postingEnabled()]);
    return NextResponse.json({ posting, item: rec, decisions, autopilot }, { headers: NO_STORE });
  } catch (e) { return financeError(e); }
}

const overrides = z.object({ vendorId: z.string().nullable().optional(), docNumber: z.string().nullable().optional(), txnDate: z.string().nullable().optional(), dueDate: z.string().nullable().optional(), classId: z.string().nullable().optional(), allowNoClass: z.boolean().optional(), lines: z.array(z.object({ accountId: z.string().nullable().optional(), classId: z.string().nullable().optional(), taxCodeId: z.string().nullable().optional(), amount: z.number().nullable().optional(), description: z.string().nullable().optional() })).optional() });
const edit = z.object({ lines: z.array(z.object({ index: z.number().int().min(0), accountId: z.string().nullable().optional(), classId: z.string().nullable().optional(), taxCodeId: z.string().nullable().optional() })).optional(), dueDate: z.string().nullable().optional(), docNumber: z.string().nullable().optional(), privateNote: z.string().nullable().optional() });
const body = z.object({ action: z.enum(["post", "hold", "reject", "reprocess", "edit_posted"]), overrides: overrides.optional(), reason: z.string().max(200).optional(), dryRun: z.boolean().optional(), changes: edit.optional() });

export async function POST(request: Request, { params }: { params: { sha: string } }) {
  try {
    const p = await requirePrincipal(request);
    sameOrigin(request);
    if (!SHA.test(params.sha)) throw new FinanceError("BAD_SHA", false, 400);
    const b = body.parse(await request.json().catch(() => ({})));
    const by = actorName(p);
    switch (b.action) {
      case "post": { const item = await postIntake(params.sha, { overrides: b.overrides, by, dryRun: b.dryRun }); return NextResponse.json({ posting: (await postingEnabled()) && !b.dryRun, item }); }
      case "hold": return NextResponse.json({ item: await holdIntake(params.sha, b.reason || "held from Finance UI", by) });
      case "reject": return NextResponse.json({ item: await rejectIntake(params.sha, b.reason || "rejected from Finance UI", by) });
      case "reprocess": return NextResponse.json({ item: await reprocessIntake(params.sha, by) });
      case "edit_posted": { const item = await editPostedIntake(params.sha, b.changes || {}, by); return NextResponse.json({ posting: await postingEnabled(), item }); }
    }
  } catch (e) { return financeError(e); }
}
