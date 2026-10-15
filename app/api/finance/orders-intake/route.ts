// GET  /api/finance/orders-intake?state=open|unmatched|matched|not_ack|duplicate|rejected|all&limit=
//      /api/finance/orders-intake?orders=all|<supplierId>   → open purchase orders for the Match select
//      /api/finance/orders-intake?pdf=<sha256>              → the acknowledgement evidence (PDF, or the email body as text) inline
// POST /api/finance/orders-intake {action:"run", since?, limit?, mailbox?}  forces a scan of the orders mailboxes
//      {action:"match", sha256, orderId} / {action:"reject", sha256, reason}
// The same shape as the original; the sub-routes below expose the same
// operations one per path for agents and scripts.
import { NextResponse } from "next/server";
import { z } from "zod";
import { actorName, requirePrincipal } from "@/lib/core/auth";
import { financeError, sameOrigin } from "@/lib/core/server";
import { listOrderAcks, matchOrderAck, openOrdersForMatching, ordersIntakeHealth, readOrderAckEvidence, rejectOrderAck, runOrdersIntakeJob, type OrderAckState } from "@/lib/finance/orders/orders-intake";
import { evidenceResponse, requireSha, STATES } from "./_shared";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    await requirePrincipal(request);
    const q = new URL(request.url).searchParams;
    const pdf = q.get("pdf");
    if (pdf) {
      const file = await readOrderAckEvidence(requireSha(pdf));
      if (!file) return NextResponse.json({ error: { code: "ORDERACK_NOT_FOUND" } }, { status: 404 });
      return evidenceResponse(file);
    }
    const orders = q.get("orders");
    if (orders) return NextResponse.json({ orders: await openOrdersForMatching(orders === "all" ? null : orders) }, { headers: { "Cache-Control": "private, no-store" } });
    const state = (STATES.includes(q.get("state") as OrderAckState) ? q.get("state") : "open") as OrderAckState | "all" | "open";
    const limit = Math.max(1, Math.min(parseInt(q.get("limit") || "100", 10) || 100, 500));
    const [items, health, everything] = await Promise.all([listOrderAcks({ state, limit }), ordersIntakeHealth(), listOrderAcks({ state: "all", limit: 500 })]);
    const counts: Record<string, number> = {};
    for (const r of everything) counts[r.state] = (counts[r.state] || 0) + 1;
    return NextResponse.json({ mailbox: health, state, counts, items }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}

const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run"), since: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), mailbox: z.string().optional() }),
  z.object({ action: z.literal("match"), sha256: z.string().regex(/^[a-f0-9]{64}$/), orderId: z.string().min(1) }),
  z.object({ action: z.literal("reject"), sha256: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(2).max(200) }),
]);
export async function POST(request: Request) {
  try {
    const p = await requirePrincipal(request);
    sameOrigin(request);
    const body = action.parse(await request.json().catch(() => ({})));
    const by = actorName(p);
    if (body.action === "run") return NextResponse.json(await runOrdersIntakeJob({ since: body.since, limit: body.limit, mailbox: body.mailbox, force: true, by }));
    if (body.action === "match") return NextResponse.json(await matchOrderAck(body.sha256, body.orderId, by));
    return NextResponse.json(await rejectOrderAck(body.sha256, body.reason, by));
  } catch (e) { return financeError(e); }
}
