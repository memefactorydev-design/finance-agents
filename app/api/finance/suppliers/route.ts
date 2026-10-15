import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { getSupplierProfile, listDisputes, listSupplierProfiles, upsertSupplierProfile, type SupplierProfile } from "@/lib/finance/suppliers";
export const dynamic = "force-dynamic";

// GET  /api/finance/suppliers — every supplier playbook entry + active dispute counts
// POST /api/finance/suppliers { vendorId, vendorName, …patch } — create (or patch) a profile
export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const [profiles, disputes] = await Promise.all([listSupplierProfiles(), listDisputes({ status: "active" })]);
    const byVendor = new Map<string, number>();
    for (const d of disputes) { const k = d.vendorId || d.vendor.toLowerCase(); byVendor.set(k, (byVendor.get(k) || 0) + 1); }
    return NextResponse.json({
      profiles: profiles.map((p) => ({ ...p, activeDisputes: (byVendor.get(p.vendorId) || 0) + (p.vendorId.startsWith("pending:") ? 0 : byVendor.get(p.vendorName.toLowerCase()) || 0) })),
      total: profiles.length,
      pending: profiles.filter((p) => p.vendorId.startsWith("pending:")).length,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}

// Same shape as upsert_supplier_profile's patch (kept inline: route files may only export handlers).
const profilePatch = z.object({
  vendorName: z.string().min(1).optional(),
  aliases: z.array(z.string()).optional(),
  emailDomains: z.array(z.string()).optional(),
  contacts: z.array(z.object({ name: z.string(), email: z.string().optional(), phone: z.string().optional(), role: z.string().optional() })).optional(),
  terms: z.object({ kind: z.enum(["days", "eom_next"]), days: z.number().int().min(0).max(120) }).nullable().optional(),
  statementAccount: z.boolean().optional(),
  blockAfterDaysOverdue: z.number().int().min(0).max(120).nullable().optional(),
  safeDaysOverdue: z.number().int().min(0).max(120).nullable().optional(),
  pressure: z.enum(["low", "medium", "high", "critical"]).optional(),
  onHold: z.boolean().optional(),
  proformaOnly: z.boolean().optional(),
  paymentMethods: z.array(z.enum(["bacs", "card", "amex", "paypal"])).optional(),
  paymentLinkWording: z.string().nullable().optional(),
  allocateOldestFirst: z.boolean().optional(),
  defaultAccountName: z.string().nullable().optional(),
  categoryHints: z.record(z.string()).optional(),
  autoPost: z.boolean().optional(),
  creditLimit: z.number().nullable().optional(),
  notes: z.string().optional(),
});
const VENDOR_ID = z.string().regex(/^(\d+|pending:[a-z0-9][a-z0-9-]*)$/, "vendorId must be a QuickBooks Vendor Id or pending:<slug>");

export async function POST(request: Request) {
  try {
    const p = await requirePrincipal(request);
    sameOrigin(request);
    const body = profilePatch.extend({ vendorId: VENDOR_ID }).parse(await request.json());
    const { vendorId, ...patch } = body;
    const existing = await getSupplierProfile(vendorId);
    if (!existing && !patch.vendorName) return NextResponse.json({ error: { code: "VENDOR_NAME_REQUIRED", message: "vendorName is required for a new profile" } }, { status: 400 });
    const profile = await upsertSupplierProfile(vendorId, patch as Partial<SupplierProfile>, actorName(p));
    return NextResponse.json({ profile, created: !existing }, { status: existing ? 200 : 201 });
  } catch (e) { return financeError(e); }
}
