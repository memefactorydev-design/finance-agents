// GET  /api/finance/intake?state=open|proposed|held|posted|duplicate|not_invoice|rejected|all&vendor=&limit=
//      /api/finance/intake?options=1[&fresh=1]  → QuickBooks vendors / accounts / classes / tax codes for the review selects
// POST /api/finance/intake {action:"run", mailbox?, limit?, since?, dryRun?}  forces an intake run
//      {action:"learn", months?}                                            learns supplier defaults from QuickBooks history
import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { getConnections } from "@/lib/core/config";
import { financeError, sameOrigin } from "@/lib/core/server";
import { postingEnabled } from "@/lib/qbo/client";
import { listIntake, runIntakeJob, intakeOptions, intakeMailboxHealth, type IntakeState } from "@/lib/finance/intake/intake";
import { learnSupplierDefaults } from "@/lib/finance/intake/learn";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const q = new URL(request.url).searchParams;
    if (q.get("options") === "1") return NextResponse.json(await intakeOptions(q.get("fresh") === "1"), { headers: NO_STORE });
    const state = (q.get("state") || "open") as IntakeState | "all" | "open";
    const limit = Math.max(1, Math.min(parseInt(q.get("limit") || "100", 10) || 100, 500));
    const cfg = await getConnections();
    const [items, mailboxes, posting] = await Promise.all([listIntake({ state, vendor: q.get("vendor") || undefined, limit }), intakeMailboxHealth(cfg), postingEnabled()]);
    const counts: Record<string, number> = {};
    for (const r of await listIntake({ state: "all", limit: 500 })) counts[r.state] = (counts[r.state] || 0) + 1;
    return NextResponse.json({ posting, intakeEnabled: cfg.intake.enabled, state, counts, mailboxes, items }, { headers: NO_STORE });
  } catch (e) { return financeError(e); }
}

const body = z.object({ action: z.enum(["run", "learn"]), mailbox: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), since: z.string().optional(), dryRun: z.boolean().optional(), months: z.number().int().min(1).max(36).optional() });
export async function POST(request: Request) {
  try {
    const p = await requirePrincipal(request);
    sameOrigin(request);
    const b = body.parse(await request.json().catch(() => ({})));
    if (b.action === "run") return NextResponse.json(await runIntakeJob({ mailbox: b.mailbox, limit: b.limit, since: b.since, dryRun: b.dryRun, force: true, by: actorName(p) }));
    return NextResponse.json(await learnSupplierDefaults({ months: b.months, by: actorName(p) }));
  } catch (e) { return financeError(e); }
}
