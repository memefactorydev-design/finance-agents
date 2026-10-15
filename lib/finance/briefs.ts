// The in-app channel the agents post their run summaries, approval requests
// and hand-offs to ("#internal-finance" in the briefs). Owners reply here
// (APPROVE <ref> / REJECT <ref>). Optionally mirrored to a Slack incoming
// webhook. Also the task list humans pick up from the agents.
import { all, upsert } from "@/lib/core/store";
import { FinanceError } from "@/lib/core/domain";
import { company, financeStore } from "@/lib/core/server";
import { getConnections } from "@/lib/core/config";

export interface Brief { id: string; channel: string; author: string; authorKind: "agent" | "human" | "system"; text: string; createdAt: string; meta?: Record<string, unknown> | null }
const key = (channel: string, id: string) => `BRIEF#${channel}#${id}`;

export async function postBrief(input: { channel?: string; author: string; authorKind?: Brief["authorKind"]; text: string; meta?: Record<string, unknown> | null; mirror?: boolean }): Promise<Brief> {
  const cfg = await getConnections();
  const channel = (input.channel || cfg.company.channelName || "internal-finance").toLowerCase().replace(/^#/, "");
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[^0-9]/g, "").slice(0, 17)}-${Math.random().toString(36).slice(2, 6)}`;
  const brief: Brief = { id, channel, author: input.author, authorKind: input.authorKind || "agent", text: input.text.slice(0, 20_000), createdAt, meta: input.meta ?? null };
  await financeStore().transact(company(), [{ key: key(channel, id), expected: null, data: brief }]);
  if (input.mirror !== false && cfg.notify.slackWebhookUrl) {
    fetch(cfg.notify.slackWebhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `*${brief.author}* · #${channel}\n${brief.text.slice(0, 3500)}` }) }).catch(() => {});
  }
  return brief;
}
export async function listBriefs(opts: { channel?: string; limit?: number; since?: string; author?: string } = {}): Promise<Brief[]> {
  const cfg = await getConnections();
  const channel = (opts.channel || cfg.company.channelName || "internal-finance").toLowerCase().replace(/^#/, "");
  const rows = await all<Brief>(financeStore(), company(), `BRIEF#${channel}#`);
  return rows.map((r) => r.data)
    .filter((b) => (!opts.since || b.createdAt >= opts.since) && (!opts.author || b.author.toLowerCase().includes(opts.author.toLowerCase())))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, Math.min(opts.limit ?? 50, 500)));
}
export async function listChannels(): Promise<string[]> {
  const rows = await all<Brief>(financeStore(), company(), "BRIEF#");
  return Array.from(new Set(rows.map((r) => r.data.channel))).sort();
}

// ------------------------------------------------------------------ tasks
export interface Task { id: string; title: string; description: string | null; assignee: string | null; projectId: string | null; dueDate: string | null; priority: "low" | "medium" | "high" | "urgent"; status: "open" | "done" | "cancelled"; createdBy: string; createdAt: string; completedAt: string | null; completedBy: string | null; tags: string[] }
export async function createTask(input: { title: string; description?: string | null; assignee?: string | null; projectId?: string | null; dueDate?: string | null; priority?: Task["priority"]; tags?: string[] }, by: string): Promise<Task> {
  const createdAt = new Date().toISOString();
  const id = `T-${createdAt.replace(/[^0-9]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  const task: Task = { id, title: input.title.slice(0, 300), description: input.description?.slice(0, 5000) ?? null, assignee: input.assignee?.toLowerCase() ?? null, projectId: input.projectId ?? null, dueDate: input.dueDate ?? null, priority: input.priority || "medium", status: "open", createdBy: by, createdAt, completedAt: null, completedBy: null, tags: input.tags || [] };
  await financeStore().transact(company(), [{ key: `TASK#${id}`, expected: null, data: task }]);
  return task;
}
export async function listTasks(opts: { status?: Task["status"] | "all"; assignee?: string; projectId?: string; limit?: number } = {}): Promise<Task[]> {
  const rows = await all<Task>(financeStore(), company(), "TASK#");
  const status = opts.status || "open";
  return rows.map((r) => r.data)
    .filter((t) => (status === "all" || t.status === status) && (!opts.assignee || (t.assignee || "") === opts.assignee.toLowerCase()) && (!opts.projectId || t.projectId === opts.projectId))
    .sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, Math.min(opts.limit ?? 100, 500)));
}
export async function completeTask(id: string, by: string, status: "done" | "cancelled" = "done"): Promise<Task> {
  return upsert<Task>(financeStore(), company(), `TASK#${id}`, (cur) => { if (!cur) throw new FinanceError("TASK_NOT_FOUND", false, 404); return { ...cur, status, completedAt: new Date().toISOString(), completedBy: by }; });
}
