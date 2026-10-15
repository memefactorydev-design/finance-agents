// Scheduled jobs for supplier-invoice intake (registered by module-jobs.ts):
//   intake            scan the intake mailboxes, then apply any APPROVE / REJECT
//                     replies the owner has left in the briefs channel or mail
//   intake-log        draft the day's supplier-invoice log to the accountant / owner
//   approvals-remind  nudge the owner about new-supplier approvals still waiting
// Params come from the cron query string (limit, mailbox, since, dryRun, force, date).
import { truthy } from "@/lib/core/domain";
import { runIntakeJob } from "./intake";
import { applyOwnerReplies, remindOwnerApprovals } from "./approvals";
import { sendIntakeLog } from "./log";

type Handler = (params: Record<string, string>) => Promise<unknown>;

export const intakeJob: Handler = async (params) => {
  const run = await runIntakeJob({
    limit: params.limit ? Number(params.limit) : undefined,
    mailbox: params.mailbox || undefined,
    since: params.since || undefined,
    dryRun: truthy(params.dryRun),
    force: truthy(params.force),
    by: params.by || "intake-job",
  });
  const ownerReplies = run.skipped ? null : await applyOwnerReplies().catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  return { run, ownerReplies };
};

export const intakeLogJob: Handler = async (params) => sendIntakeLog({ date: params.date || undefined, to: params.to ? params.to.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : undefined, actor: params.by || "intake-log-job" });

export const approvalsRemindJob: Handler = async (params) => remindOwnerApprovals({ by: params.by || undefined });
