import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { addProjectNote, listProjectNotes } from "@/lib/crm/projects";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try { await requirePrincipal(request); return NextResponse.json({ notes: await listProjectNotes(params.id) }); } catch (e) { return financeError(e); }
}
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try { const p = await requirePrincipal(request); const { text } = z.object({ text: z.string().min(1).max(5000) }).parse(await request.json()); return NextResponse.json({ note: await addProjectNote(params.id, text, actorName(p)) }); } catch (e) { return financeError(e); }
}
