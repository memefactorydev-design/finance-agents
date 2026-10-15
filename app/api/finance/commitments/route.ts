import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requireAdmin, requirePrincipal } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { listCommitments, upsertCommitment } from "@/lib/finance/suppliers";
export const dynamic = "force-dynamic";

// GET  /api/finance/commitments?includeInactive=1 — loans, overheads, payroll, tax, cards
// POST /api/finance/commitments {kind, name, amount, frequency, …} — admin: create / update (id to update)
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const input = z.object({ id: z.string().optional(), kind: z.enum(["loan", "overhead", "payroll", "tax", "card"]), name: z.string().min(1).max(80), amount: z.number().min(0), frequency: z.enum(["weekly", "monthly", "quarterly", "once"]), dueDay: z.number().int().min(1).max(31).nullable().optional(), nextDue: ISO_DATE.nullable().optional(), balance: z.number().nullable().optional(), endDate: ISO_DATE.nullable().optional(), notes: z.string().max(500).optional(), active: z.boolean().optional() });

export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const commitments = await listCommitments(new URL(request.url).searchParams.get("includeInactive") === "1");
    return NextResponse.json({ total: commitments.length, commitments }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}
export async function POST(request: Request) {
  try {
    const p = await requirePrincipal(request);
    requireAdmin(p);
    sameOrigin(request);
    const commitment = await upsertCommitment(input.parse(await request.json()), actorName(p));
    return NextResponse.json({ commitment });
  } catch (e) { return financeError(e); }
}
