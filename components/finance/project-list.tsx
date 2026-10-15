"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderKanban, Plus, Search, RefreshCw, FolderSync } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { projectName, type Project } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import { api, useApi, useCompany, useMoney } from "@/components/use-api";
import { ProjectStatusChip } from "./status-chip";
import { ProjectFormDialog } from "./project-form-dialog";
import { ErrorNote, Empty, TH, THEAD } from "./section";
import { fmtDate, personName } from "./money";
import type { StatusResponse, SyncResult } from "./types";

export function ProjectList() {
  const router = useRouter();
  const { money } = useMoney();
  const { user } = useCompany();
  const [status, setStatus] = React.useState<"all" | "active" | "completed" | "cancelled" | "lost">("active");
  const [q, setQ] = React.useState("");
  const { data, error, loading, reload } = useApi<{ projects: Project[] }>(`/api/finance/projects?status=${status}${status === "all" ? "&includeCancelled=1" : ""}`);
  const { data: statusData } = useApi<StatusResponse>("/api/finance/status");
  const crmMode = statusData?.setup.crm.mode || "manual";
  const [creating, setCreating] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const rows = React.useMemo(() => {
    const list = data?.projects || [];
    const n = q.trim().toLowerCase();
    if (!n) return list;
    return list.filter((p) => `${p.firstName} ${p.lastName} ${p.postcode || ""} ${p.email || ""} ${p.id} ${p.designer || ""}`.toLowerCase().includes(n));
  }, [data, q]);
  const sync = async () => {
    setSyncing(true);
    try { const r = await api<SyncResult>("/api/finance/crm-sync", { method: "POST", json: {} }); toast[r.ok ? "success" : "error"](r.ok ? `Synced ${r.upserted} of ${r.fetched} projects` : `Sync failed: ${r.errors[0] || "unknown"}`); reload(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Sync failed"); } finally { setSyncing(false); }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10"><FolderKanban className="h-5 w-5 text-primary" /></div>
          <div><h1 className="text-xl font-bold">Projects</h1><p className="text-sm text-muted-foreground">Won jobs with their contract value, payment schedule, receipts, invoices and supplier orders{crmMode !== "manual" ? ` · managed by your CRM (${crmMode})` : ""}</p></div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {crmMode === "rest" || crmMode === "mcp" ? <Button variant="outline" size="sm" className="gap-1.5" onClick={sync} disabled={syncing}><FolderSync className={cn("h-3.5 w-3.5", syncing && "animate-spin")} /> {syncing ? "Syncing…" : "Sync now"}</Button> : null}
          <Button variant="outline" size="sm" className="gap-1.5" onClick={reload} disabled={loading}><RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh</Button>
          <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)} disabled={!user}><Plus className="h-4 w-4" /> New project</Button>
        </div>
      </div>
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative"><Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input className="h-9 w-56 pl-8" placeholder="Search name, postcode, email, id" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}><SelectTrigger className="h-9 w-40" aria-label="Status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="completed">Completed</SelectItem><SelectItem value="cancelled">Cancelled</SelectItem><SelectItem value="lost">Lost</SelectItem><SelectItem value="all">All</SelectItem></SelectContent></Select>
          <span className="ml-auto text-xs text-muted-foreground">{rows.length} project{rows.length === 1 ? "" : "s"}</span>
        </div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {data && rows.length === 0 ? <Empty icon={FolderKanban}>{q ? "No project matches your search." : crmMode === "manual" ? "No projects yet. Create your first project to build its payment schedule." : "No projects synced yet. Run a sync or check the CRM connector in Setup."}</Empty> : null}
        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className={THEAD}><tr><TH>Client</TH><TH>Status</TH><TH>Stage</TH><TH>Salesperson</TH><TH>Won</TH><TH right>Net value</TH><TH>Source</TH></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="cursor-pointer border-b border-border/40 hover:bg-muted/30" onClick={() => router.push(`/projects/${encodeURIComponent(p.id)}`)}>
                    <td className="p-2"><Link href={`/projects/${encodeURIComponent(p.id)}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{projectName(p) || p.id}</Link><span className="block text-[11px] text-muted-foreground">{[p.postcode, p.email].filter(Boolean).join(" · ") || p.id}</span></td>
                    <td className="p-2"><ProjectStatusChip status={p.status} /></td>
                    <td className="p-2 text-xs text-muted-foreground">{p.opsStage || "—"}</td>
                    <td className="p-2 text-xs text-muted-foreground">{personName(p.designer)}</td>
                    <td className="p-2 text-xs">{fmtDate(p.wonDate)}</td>
                    <td className="p-2 text-right tabular-nums">{p.wonValue != null ? money(p.wonValue) : "—"}</td>
                    <td className="p-2"><Badge variant="secondary" className="text-[10px]">{p.source.kind}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      <ProjectFormDialog open={creating} onOpenChange={setCreating} project={null} onSaved={(p) => { setCreating(false); router.push(`/projects/${encodeURIComponent(p.id)}`); }} />
    </div>
  );
}
