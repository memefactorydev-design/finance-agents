// GET /api/cron?job=intake|orders|qbo|crm-sync|intake-log|all
// Protected by CRON_SECRET (Authorization: Bearer …) when set. Vercel Cron
// sends the header automatically; scripts/scheduler.ts does the same locally.
import { NextResponse, type NextRequest } from "next/server";
import { runJob, jobNames, loadJobs } from "@/lib/finance/jobs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  const auth = request.headers.get("authorization") || "";
  if (secret && auth !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await loadJobs();
  const job = request.nextUrl.searchParams.get("job") || "all";
  const started = Date.now();
  const names = job === "all" ? jobNames() : [job];
  const results: Record<string, unknown> = {};
  for (const name of names) {
    try { results[name] = await runJob(name, Object.fromEntries(request.nextUrl.searchParams.entries())); }
    catch (e) { results[name] = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  return NextResponse.json({ ok: true, job, results, ms: Date.now() - started });
}
