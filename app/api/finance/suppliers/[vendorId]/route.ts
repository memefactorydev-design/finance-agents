import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { getSupplierProfile, listDisputes, upsertSupplierProfile, type SupplierProfile } from "@/lib/finance/suppliers";
export const dynamic = "force-dynamic";

// GET /api/finance/suppliers/<vendorId>       — one profile + its active disputes
// PUT /api/finance/suppliers/<vendorId> {…}   — patch (creates when absent; vendorName required then)
// vendorId is a QuickBooks Vendor Id or pending:<slug>.
const VENDOR_ID = /^(\d+|pending:[a-z0-9][a-z0-9-]*)$/;
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

export async function GET(request: Request, { params }: { params: { vendorId: string } }) {
  try {
    await requirePrincipal(request);
    const vendorId = decodeURIComponent(params.vendorId);
    const profile = await getSupplierProfile(vendorId);
    if (!profile) return NextResponse.json({ error: { code: "NOT_FOUND", message: "No supplier profile" } }, { status: 404 });
    const disputes = (await listDisputes({ status: "active" })).filter((d) => d.vendorId === vendorId || d.vendor.toLowerCase() === profile.vendorName.toLowerCase());
    return NextResponse.json({ profile, disputes }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}

export async function PUT(request: Request, { params }: { params: { vendorId: string } }) {
  try {
    const p = await requirePrincipal(request);
    sameOrigin(request);
    const vendorId = decodeURIComponent(params.vendorId);
    if (!VENDOR_ID.test(vendorId)) return NextResponse.json({ error: { code: "VENDOR_ID_INVALID", message: "vendorId must be a QuickBooks Vendor Id or pending:<slug>" } }, { status: 400 });
    const patch = profilePatch.parse(await request.json());
    const existing = await getSupplierProfile(vendorId);
    if (!existing && !patch.vendorName) return NextResponse.json({ error: { code: "VENDOR_NAME_REQUIRED", message: "vendorName is required for a new profile" } }, { status: 400 });
    const profile = await upsertSupplierProfile(vendorId, patch as Partial<SupplierProfile>, actorName(p));
    return NextResponse.json({ profile, created: !existing });
  } catch (e) { return financeError(e); }
}
