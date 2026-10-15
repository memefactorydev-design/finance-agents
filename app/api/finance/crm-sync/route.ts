import { NextResponse } from "next/server";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { lastSync, syncProjects } from "@/lib/crm/connectors";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function GET(request: Request) { try { await requirePrincipal(request); return NextResponse.json({ last: await lastSync() }); } catch (e) { return financeError(e); } }
export async function POST(request: Request) { try { const p = await requirePrincipal(request); return NextResponse.json(await syncProjects({ by: actorName(p) })); } catch (e) { return financeError(e); } }
