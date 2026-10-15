// POST /api/finance/orders-intake/run {since?, limit?, mailbox?} — scan the
// orders mailboxes now (ignores the intake.ordersEnabled gate).
import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { runOrdersIntakeJob } from "@/lib/finance/orders/orders-intake";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const input = z.object({ since: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), mailbox: z.string().optional() });
export async function POST(request: Request) {
  try {
    const p = await requirePrincipal(request);
    sameOrigin(request);
    const body = input.parse(await request.json().catch(() => ({})));
    return NextResponse.json(await runOrdersIntakeJob({ ...body, force: true, by: actorName(p) }));
  } catch (e) { return financeError(e); }
}
