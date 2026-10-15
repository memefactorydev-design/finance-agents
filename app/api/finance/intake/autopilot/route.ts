// GET /api/finance/intake/autopilot → { posting, autopilot, suppliersOnAutoPost, suppliers }
// PUT /api/finance/intake/autopilot { mode?, minConfidence?, requireClass?, requireKnownVendor? } (admin — the owner's switch)
// QuickBooks posting (quickbooks.postBills) stays the master switch.
import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requireAdmin, requirePrincipal } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { postingEnabled } from "@/lib/qbo/client";
import { getAutopilot, setAutopilot, type AutopilotConfig } from "@/lib/finance/intake/learning";
import { listSupplierProfiles } from "@/lib/finance/suppliers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function payload(autopilot: AutopilotConfig) {
  const [profiles, posting] = await Promise.all([listSupplierProfiles().catch(() => []), postingEnabled()]);
  return { posting, autopilot, suppliersOnAutoPost: profiles.filter((p) => p.autoPost).length, suppliers: profiles.length };
}

export async function GET(request: Request) {
  try { await requirePrincipal(request); return NextResponse.json(await payload(await getAutopilot()), { headers: { "Cache-Control": "private, no-store" } }); }
  catch (e) { return financeError(e); }
}

const body = z.object({ mode: z.enum(["manual", "assisted", "full"]).optional(), minConfidence: z.number().optional(), requireClass: z.boolean().optional(), requireKnownVendor: z.boolean().optional() });
export async function PUT(request: Request) {
  try {
    const p = await requirePrincipal(request);
    requireAdmin(p);
    sameOrigin(request);
    const b = body.parse(await request.json().catch(() => ({})));
    return NextResponse.json(await payload(await setAutopilot(b, actorName(p))));
  } catch (e) { return financeError(e); }
}
