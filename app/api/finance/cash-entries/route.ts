import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { appendCashEntry, CASH_SECTIONS, listCashEntries, type CashSection } from "@/lib/finance/suppliers";
export const dynamic = "force-dynamic";

// GET  /api/finance/cash-entries?from=YYYY-MM-DD&to=YYYY-MM-DD — manual cash lines
// POST /api/finance/cash-entries {date, section, label, amount, note?, confirmed?} — add one
// (stored as CASH_ENTRY# so it survives every report rebuild; humans post with source "owner")
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const input = z.object({ date: ISO_DATE, section: z.enum(CASH_SECTIONS as [CashSection, ...CashSection[]]), label: z.string().min(1).max(120), amount: z.number().positive(), note: z.string().max(300).optional(), confirmed: z.boolean().optional().default(false) });

export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const u = new URL(request.url);
    const entries = await listCashEntries(u.searchParams.get("from") || undefined, u.searchParams.get("to") || undefined);
    return NextResponse.json({ total: entries.length, entries }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}
export async function POST(request: Request) {
  try {
    const p = await requirePrincipal(request);
    sameOrigin(request);
    const b = input.parse(await request.json());
    const entry = await appendCashEntry({ date: b.date, section: b.section, label: b.label, amount: b.amount, note: b.note ?? null, source: p.kind === "api_key" ? "agent" : "owner", confirmed: b.confirmed }, actorName(p));
    return NextResponse.json({ entry }, { status: 201 });
  } catch (e) { return financeError(e); }
}
