// Scheduled job for the orders module: scan the orders mailboxes for supplier
// acknowledgements. Registered as "orders" by lib/finance/module-jobs.ts; the
// cron route passes its query string through as params.
//   limit   max PDFs this run (default 20)
//   since   ISO date-time to rescan from (ignores the mailbox watermark)
//   force   run even when intake.ordersEnabled is off
//   mailbox scan one of the orders mailboxes only
import { truthy } from "@/lib/core/domain";
import { runOrdersIntakeJob, type OrdersIntakeRunSummary } from "./orders-intake";

export type OrdersJob = (params: Record<string, string>) => Promise<OrdersIntakeRunSummary>;
export const ordersJob: OrdersJob = async (params) => {
  const limit = params.limit ? parseInt(params.limit, 10) : NaN;
  return runOrdersIntakeJob({
    limit: Number.isFinite(limit) ? limit : undefined,
    since: params.since || undefined,
    force: truthy(params.force),
    mailbox: params.mailbox || undefined,
    by: params.by || "cron",
  });
};
