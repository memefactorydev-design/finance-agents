// Orders-intake tools: supplier order acknowledgements / confirmations found
// in the orders mailboxes (PDF attachments and email bodies) and matched to
// purchase orders. Matching writes the ack onto the order (acknowledged /
// discrepancy, supplier cost for the supplier P&L) and a project note,
// attributed "(agent)". Tool names are the ones the agent briefs use.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { actorName, ok, principalFrom, runTool, type Extra } from "./auth";
import { getConnections } from "@/lib/core/config";
import { ordersMailboxes } from "@/lib/mail";
import { listOrderAcks, matchOrderAck, openOrdersForMatching, rejectOrderAck, runOrdersIntakeJob, type OrderAckRecord } from "@/lib/finance/orders/orders-intake";

const sha = z.string().regex(/^[a-f0-9]{64}$/, "sha256 hex");

const slim = (r: OrderAckRecord) => ({
  sha256: r.sha256, state: r.state, kind: r.kind || "pdf", reasons: r.reasons,
  received: r.arrivals[0]?.receivedAt || r.createdAt,
  arrivals: r.arrivals.map((a) => ({ mailbox: a.mailbox, from: a.from, subject: a.subject, fileName: a.fileName, receivedAt: a.receivedAt })),
  supplier: r.supplier, order: r.order,
  acknowledgementRef: r.extraction?.acknowledgementRef ?? null, expectedDate: r.extraction?.expectedDate ?? null,
  extras: r.extraction?.extras ?? [], printedTotal: r.extraction?.total ?? null,
  lines: r.extraction?.lines.length ?? 0,
  ack: r.ack ? { status: r.ack.status, discrepancies: r.ack.discrepancies, supplierCost: r.ack.supplierCost ?? null, orderedCost: r.ack.orderedCost ?? null } : null,
  decidedBy: r.decidedBy, decidedAt: r.decidedAt,
});

export function registerOrdersTools(server: McpServer) {
  server.registerTool(
    "list_order_acks",
    {
      title: "List supplier order acknowledgements",
      description: "Order acknowledgements / confirmations found in the orders mailboxes (PDF attachments and email bodies), with the supplier and purchase order they were matched to, the extracted line count, extra charges, the acknowledged supplier cost vs the ordered cost and any differences against the order. state 'open' (default) = unmatched items needing a decision; also matched, not_ack, duplicate, rejected, all.",
      inputSchema: {
        state: z.enum(["open", "unmatched", "matched", "not_ack", "duplicate", "rejected", "all"]).optional().default("open"),
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, extra: Extra) => runTool(async () => {
      principalFrom(extra.authInfo);
      const [cfg, items] = await Promise.all([getConnections(), listOrderAcks({ state: args.state, limit: args.limit })]);
      return ok({ mailboxes: ordersMailboxes(cfg), state: args.state, total: items.length, items: items.map(slim) });
    }),
  );

  server.registerTool(
    "match_order_ack",
    {
      title: "Match an acknowledgement to a purchase order",
      description: "Attach an unmatched (or mis-matched) acknowledgement to the given purchase order: lines, extras and totals are compared to the order, the order becomes acknowledged or discrepancy with the supplier cost recorded, and the project gets a note (plus a brief when there are differences). Use list_order_acks to find the sha256 and list_open_orders_for_ack for the orderId. Fails if no line items can be extracted.",
      inputSchema: { sha256: sha, orderId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args, extra: Extra) => runTool(async () => {
      const p = principalFrom(extra.authInfo);
      return ok(slim(await matchOrderAck(args.sha256, args.orderId, actorName(p))));
    }),
  );

  server.registerTool(
    "reject_order_ack",
    {
      title: "Reject an acknowledgement",
      description: "Mark an intake item (PDF or email body) as not relevant (marketing, wrong company, superseded). Cannot reject one already applied to an order — change the order's ack instead.",
      inputSchema: { sha256: sha, reason: z.string().min(2).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args, extra: Extra) => runTool(async () => {
      const p = principalFrom(extra.authInfo);
      return ok(slim(await rejectOrderAck(args.sha256, args.reason, actorName(p))));
    }),
  );

  server.registerTool(
    "list_open_orders_for_ack",
    {
      title: "Open purchase orders for matching",
      description: "Purchase orders that can still receive an acknowledgement (signed off, sent, acknowledged, discrepancy), optionally for one supplier (supplier profile vendorId) — the candidates for match_order_ack.",
      inputSchema: { supplierId: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async (args, extra: Extra) => runTool(async () => {
      principalFrom(extra.authInfo);
      const orders = await openOrdersForMatching(args.supplierId || null);
      return ok({ total: orders.length, orders });
    }),
  );

  server.registerTool(
    "run_orders_intake",
    {
      title: "Scan the orders mailboxes now",
      description: "Force a scan of the orders mailboxes for acknowledgements — PDF attachments and plain email replies (default: since each mailbox's last watermark; 'since' rescans from an ISO date). Budget ≤ 20 PDFs / ≤ 8 email bodies / ≤ 150 mail calls per run. Returns what was found, matched and left for review.",
      inputSchema: {
        since: z.string().optional().describe("ISO date-time to rescan from, e.g. 2026-10-01T00:00:00Z"),
        limit: z.number().int().min(1).max(100).optional().describe("Max PDFs this run (default 20)"),
        mailbox: z.string().optional().describe("Scan one of the orders mailboxes only"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args, extra: Extra) => runTool(async () => {
      const p = principalFrom(extra.authInfo);
      return ok(await runOrdersIntakeJob({ since: args.since, limit: args.limit, mailbox: args.mailbox, force: true, by: actorName(p) }));
    }),
  );
}
