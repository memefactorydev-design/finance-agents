import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { listProjects, searchProjects, upsertProject } from "@/lib/crm/projects";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const u = new URL(request.url);
    const q = u.searchParams.get("q");
    const status = (u.searchParams.get("status") || "all") as "all" | "active" | "completed" | "cancelled" | "lost";
    const projects = q ? await searchProjects(q) : await listProjects({ status, includeCancelled: u.searchParams.get("includeCancelled") === "1" });
    return NextResponse.json({ projects });
  } catch (e) { return financeError(e); }
}
const input = z.object({ id: z.string().optional(), firstName: z.string().default(""), lastName: z.string().min(1), email: z.string().nullable().optional(), phone: z.string().nullable().optional(), postcode: z.string().nullable().optional(), address: z.string().nullable().optional(), designer: z.string().nullable().optional(), status: z.enum(["active", "completed", "cancelled", "lost"]).optional(), opsStage: z.string().nullable().optional(), wonDate: z.string().nullable().optional(), wonValue: z.number().nullable().optional(), surveyOrderAt: z.string().nullable().optional(), deliveryDate: z.string().nullable().optional(), installStart: z.string().nullable().optional(), installEnd: z.string().nullable().optional(), signOff1At: z.string().nullable().optional(), signOff2At: z.string().nullable().optional(), supplyOnly: z.boolean().nullable().optional(), notes: z.string().nullable().optional(), supplierOrders: z.array(z.any()).optional(), qbo: z.any().optional(), costing: z.any().optional() });
export async function POST(request: Request) {
  try {
    const p = await requirePrincipal(request);
    const body = input.parse(await request.json());
    const project = await upsertProject({ ...body, source: { kind: "manual", externalId: null, syncedAt: null } }, actorName(p));
    return NextResponse.json({ project });
  } catch (e) { return financeError(e); }
}
