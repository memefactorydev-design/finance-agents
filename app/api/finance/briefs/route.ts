import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { listBriefs, listChannels, postBrief } from "@/lib/finance/briefs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const u = new URL(request.url);
    const briefs = await listBriefs({ channel: u.searchParams.get("channel") || undefined, limit: Number(u.searchParams.get("limit") || 50), since: u.searchParams.get("since") || undefined });
    return NextResponse.json({ briefs, channels: await listChannels() });
  } catch (e) { return financeError(e); }
}
export async function POST(request: Request) {
  try {
    const p = await requirePrincipal(request);
    const { text, channel } = z.object({ text: z.string().min(1).max(20000), channel: z.string().max(60).optional() }).parse(await request.json());
    return NextResponse.json({ brief: await postBrief({ channel, author: actorName(p), authorKind: p.kind === "api_key" ? "agent" : "human", text }) });
  } catch (e) { return financeError(e); }
}
