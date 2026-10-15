"use client";

import * as React from "react";
import Link from "next/link";
import { ListChecks, Plus, Check, X, CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api, useApi } from "@/components/use-api";
import { ErrorNote, Empty, Pills, label } from "./section";
import { fmtDate, todayIso } from "./money";
import type { Task, TasksResponse } from "./types";

// The task list humans pick up from the agents (and add for each other).
const PRIORITY: Record<Task["priority"], string> = { low: "bg-muted text-muted-foreground", medium: "bg-sky-500/10 text-sky-600 dark:text-sky-400", high: "bg-amber-500/15 text-amber-600", urgent: "bg-red-500/15 text-red-500" };
type Draft = { title: string; description: string; assignee: string; dueDate: string; priority: Task["priority"]; projectId: string };
const empty: Draft = { title: "", description: "", assignee: "", dueDate: "", priority: "medium", projectId: "" };

export function TasksPanel() {
  const [status, setStatus] = React.useState<"open" | "done" | "all">("open");
  const { data, error, loading, reload } = useApi<TasksResponse>(`/api/finance/tasks?status=${status}`);
  const [adding, setAdding] = React.useState(false);
  const [d, setD] = React.useState<Draft>(empty);
  const [busy, setBusy] = React.useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const create = async () => {
    if (!d.title.trim()) { toast.error("Give the task a title"); return; }
    setBusy("new");
    try { await api("/api/finance/tasks", { method: "POST", json: { title: d.title.trim(), description: d.description.trim() || null, assignee: d.assignee.trim() || null, dueDate: d.dueDate || null, priority: d.priority, projectId: d.projectId.trim() || null } }); setD(empty); setAdding(false); await reload(); toast.success("Task added"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not add task"); } finally { setBusy(null); }
  };
  const close = async (t: Task, s: "done" | "cancelled") => {
    setBusy(t.id);
    try { await api(`/api/finance/tasks/${encodeURIComponent(t.id)}`, { method: "PATCH", json: { status: s } }); await reload(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Update failed"); } finally { setBusy(null); }
  };
  const tasks = data?.tasks || [];
  const today = todayIso();
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold"><ListChecks className="h-4 w-4 text-primary" /> Tasks</h2>
        <div className="flex items-center gap-2">
          <Pills value={status} onChange={setStatus} items={[{ key: "open", label: "Open" }, { key: "done", label: "Done" }, { key: "all", label: "All" }]} />
          <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => setAdding((a) => !a)}><Plus className="h-3 w-3" /> New</Button>
        </div>
      </div>
      {adding ? (
        <div className="mb-3 space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
          <Input className="h-8 text-sm" placeholder="Title" value={d.title} onChange={(e) => set("title", e.target.value)} autoFocus />
          <Textarea className="min-h-[48px] text-xs" placeholder="Details (optional)" value={d.description} onChange={(e) => set("description", e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <div><p className={label}>Assignee (email)</p><Input className="h-8 text-xs" value={d.assignee} onChange={(e) => set("assignee", e.target.value)} /></div>
            <div><p className={label}>Due</p><Input className="h-8 text-xs" type="date" value={d.dueDate} onChange={(e) => set("dueDate", e.target.value)} /></div>
            <div><p className={label}>Priority</p><select className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs" value={d.priority} onChange={(e) => set("priority", e.target.value as Task["priority"])}>{(["low", "medium", "high", "urgent"] as const).map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
            <div><p className={label}>Project id (optional)</p><Input className="h-8 font-mono text-xs" value={d.projectId} onChange={(e) => set("projectId", e.target.value)} /></div>
          </div>
          <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setAdding(false)}>Cancel</Button><Button size="sm" className="h-7 text-xs" onClick={create} disabled={busy === "new"}>{busy === "new" ? "Adding…" : "Add task"}</Button></div>
        </div>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {data && tasks.length === 0 && !loading ? <Empty icon={ListChecks}>{status === "open" ? "No open tasks. The agents add tasks here when something needs a human." : "Nothing here."}</Empty> : null}
      <ul className="space-y-2">
        {tasks.map((t) => {
          const overdue = t.status === "open" && !!t.dueDate && t.dueDate < today;
          return (
            <li key={t.id} className={cn("rounded-lg border border-border/60 p-2.5 text-sm", t.status !== "open" && "opacity-70")}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className={cn("font-medium", t.status === "done" && "line-through")}>{t.title}</p>
                  {t.description ? <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">{t.description}</p> : null}
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    <Badge className={cn("border-0 text-[9px] uppercase", PRIORITY[t.priority])}>{t.priority}</Badge>
                    {t.assignee ? <span>→ {t.assignee}</span> : null}
                    {t.dueDate ? <span className={cn("inline-flex items-center gap-1", overdue && "font-medium text-red-500")}><CalendarClock className="h-3 w-3" /> {fmtDate(t.dueDate)}{overdue ? " · overdue" : ""}</span> : null}
                    {t.projectId ? <Link href={`/projects/${encodeURIComponent(t.projectId)}`} className="underline">project</Link> : null}
                    <span>by {t.createdBy}</span>
                    {t.tags?.length ? <span>{t.tags.map((x) => `#${x}`).join(" ")}</span> : null}
                  </p>
                </div>
                {t.status === "open" ? (
                  <div className="flex shrink-0 gap-1">
                    <Button variant="outline" size="icon-sm" className="h-7 w-7 text-emerald-600" title="Done" aria-label="Mark done" disabled={busy === t.id} onClick={() => close(t, "done")}><Check className="h-3.5 w-3.5" /></Button>
                    <Button variant="ghost" size="icon-sm" className="h-7 w-7 text-muted-foreground" title="Cancel task" aria-label="Cancel task" disabled={busy === t.id} onClick={() => close(t, "cancelled")}><X className="h-3.5 w-3.5" /></Button>
                  </div>
                ) : <Badge variant="secondary" className="text-[10px]">{t.status}</Badge>}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
