// Jobs contributed by the finance modules. Each module exports its handlers
// from its own jobs.ts; add a line here when a module gains a scheduled job.
import * as intake from "./intake/jobs";
import * as orders from "./orders/jobs";
import * as reports from "./reports/jobs";
type Handler = (params: Record<string, string>) => Promise<unknown>;
type Register = (name: string, handler: Handler) => void;
export async function registerModuleJobs(register: Register) {
  if (intake.intakeJob) register("intake", intake.intakeJob);
  if (intake.intakeLogJob) register("intake-log", intake.intakeLogJob);
  if (intake.approvalsRemindJob) register("approvals-remind", intake.approvalsRemindJob);
  if (orders.ordersJob) register("orders", orders.ordersJob);
  if (reports.reportsJob) register("reports", reports.reportsJob);
}
