import { NextResponse } from "next/server";
import { z } from "zod";
import { createApiKey, listApiKeys, requireUser, revokeApiKey } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
export const dynamic = "force-dynamic";
export async function GET() { try { await requireUser(); return NextResponse.json({ keys: await listApiKeys() }); } catch (e) { return financeError(e); } }
export async function POST(request: Request) {
  try {
    sameOrigin(request); await requireUser();
    const { name, role } = z.object({ name: z.string().min(1).max(60), role: z.enum(["admin", "agent"]).default("admin") }).parse(await request.json());
    const { key, row } = await createApiKey(name, role);
    return NextResponse.json({ key, row });
  } catch (e) { return financeError(e); }
}
export async function DELETE(request: Request) {
  try {
    sameOrigin(request); await requireUser();
    const { id } = z.object({ id: z.string() }).parse(await request.json());
    await revokeApiKey(id);
    return NextResponse.json({ ok: true });
  } catch (e) { return financeError(e); }
}
