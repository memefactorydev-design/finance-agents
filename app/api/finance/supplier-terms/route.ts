import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requireAdmin, requirePrincipal } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { applySupplierTerms } from "@/lib/finance/supplier-terms";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/finance/supplier-terms {mode: "plan"|"apply", cutoff, terms:[{supplier, term}]}
// Admin only. "plan" is read-only; "apply" writes Terms, Vendor.TermRef and
// bill due dates to QuickBooks and marks pre-cutoff bills disputed — only
// with posting on, otherwise the plan is returned as a dry run.
const input = z.object({ mode: z.enum(["plan", "apply"]).default("plan"), cutoff: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), terms: z.array(z.object({ supplier: z.string().min(1), term: z.string().min(1) })).min(1).max(200) });
export async function POST(request: Request) {
  try {
    const p = await requirePrincipal(request);
    requireAdmin(p);
    sameOrigin(request);
    const b = input.parse(await request.json());
    return NextResponse.json(await applySupplierTerms({ mode: b.mode, cutoff: b.cutoff, terms: b.terms, actor: actorName(p) }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}
