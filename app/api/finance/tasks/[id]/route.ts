import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { completeTask } from "@/lib/finance/briefs";
export const dynamic = "force-dynamic";
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try { const p = await requirePrincipal(request); const { status } = z.object({ status: z.enum(["done", "cancelled"]).default("done") }).parse(await request.json().catch(() => ({}))); return NextResponse.json({ task: await completeTask(params.id, actorName(p), status) }); } catch (e) { return financeError(e); }
}
