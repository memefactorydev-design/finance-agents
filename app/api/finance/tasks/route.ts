import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { createTask, listTasks } from "@/lib/finance/briefs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { await requirePrincipal(request); const u = new URL(request.url); return NextResponse.json({ tasks: await listTasks({ status: (u.searchParams.get("status") as "open" | "done" | "cancelled" | "all") || "open", assignee: u.searchParams.get("assignee") || undefined, projectId: u.searchParams.get("projectId") || undefined }) }); } catch (e) { return financeError(e); }
}
export async function POST(request: Request) {
  try {
    const p = await requirePrincipal(request);
    const body = z.object({ title: z.string().min(1).max(300), description: z.string().max(5000).nullable().optional(), assignee: z.string().nullable().optional(), projectId: z.string().nullable().optional(), dueDate: z.string().nullable().optional(), priority: z.enum(["low", "medium", "high", "urgent"]).optional(), tags: z.array(z.string()).optional() }).parse(await request.json());
    return NextResponse.json({ task: await createTask(body, actorName(p)) });
  } catch (e) { return financeError(e); }
}
