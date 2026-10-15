import { NextResponse } from "next/server";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { deleteProject, requireProject, upsertProject } from "@/lib/crm/projects";
import { resolveSchedule, scheduleTotals, contractGross, contractNet } from "@/lib/crm/schedule";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    await requirePrincipal(request);
    const project = await requireProject(params.id);
    const lines = resolveSchedule(project);
    return NextResponse.json({ project, schedule: { lines, totals: scheduleTotals(lines), contractGross: contractGross(project), contractNet: contractNet(project) } });
  } catch (e) { return financeError(e); }
}
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const p = await requirePrincipal(request);
    const current = await requireProject(params.id);
    const patch = await request.json();
    const project = await upsertProject({ ...current, ...patch, id: params.id, firstName: patch.firstName ?? current.firstName, lastName: patch.lastName ?? current.lastName }, actorName(p));
    return NextResponse.json({ project });
  } catch (e) { return financeError(e); }
}
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  try { await requirePrincipal(request); await deleteProject(params.id); return NextResponse.json({ ok: true }); } catch (e) { return financeError(e); }
}
