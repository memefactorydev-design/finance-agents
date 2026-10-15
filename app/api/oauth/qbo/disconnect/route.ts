import { NextResponse } from "next/server";
import { requireUser } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { qboOAuth } from "@/lib/qbo/client";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try { sameOrigin(request); const user = await requireUser(); await (await qboOAuth()).disconnect(user.id); return NextResponse.json({ ok: true }); }
  catch (e) { return financeError(e); }
}
