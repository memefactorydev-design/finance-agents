// Intuit webhooks (optional): verifies the signature and invalidates caches so
// the next read is fresh. Nothing is written in response to a webhook.
import { NextResponse } from "next/server";
import { verifyQboWebhook } from "@/lib/qbo/oauth";
import { invalidateRefData } from "@/lib/qbo/client";
import { financeError } from "@/lib/core/server";
import { invalidateFinanceCaches } from "@/lib/finance/caches";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    verifyQboWebhook(raw, request.headers.get("intuit-signature") || "", process.env.QBO_WEBHOOK_VERIFIER || "");
    invalidateRefData();
    invalidateFinanceCaches();
    return NextResponse.json({ ok: true });
  } catch (e) { return financeError(e); }
}
