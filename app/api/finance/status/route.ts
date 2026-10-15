import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { setupState } from "@/lib/core/setup";
import { quickBooksStatus } from "@/lib/qbo/status";
import { lastSync } from "@/lib/crm/connectors";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { await requirePrincipal(request); const [setup, quickbooks, crm] = await Promise.all([setupState(), quickBooksStatus(), lastSync()]); return NextResponse.json({ setup, quickbooks, crm }); } catch (e) { return financeError(e); }
}
