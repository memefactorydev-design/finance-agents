"use client";

import * as React from "react";
import Link from "next/link";
import { Activity, Play, Terminal, CheckCircle2, XCircle, Inbox, Link2, Database, KeyRound, FolderSync } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api, ApiError, copyText } from "@/components/use-api";
import { Section, RefreshButton, ErrorNote, TH, THEAD } from "./section";
import { fmtWhen } from "./money";
import type { CronResponse, StatusResponse } from "./types";
import { toast } from "sonner";

// Scheduled jobs (vercel.json / scripts/scheduler.ts) with a "run now" button
// per job. GET /api/cron is protected by CRON_SECRET when that env var is
// set: the browser cannot send it, so a 401 shows the curl to run instead.
const JOBS = [
  { name: "intake", label: "Supplier invoice intake", schedule: "every 15 min, 06:00–19:00 Mon–Sat", does: "Scans the intake mailboxes for PDF invoices, extracts and codes them." },
  { name: "orders", label: "Order acknowledgements", schedule: "twice an hour, 06:00–19:00 Mon–Sat", does: "Scans the orders mailboxes and matches acknowledgements to purchase orders." },
  { name: "qbo", label: "QuickBooks health + ledger", schedule: "every 15 min", does: "Checks the token, heals a lost refresh, warms the ledger copy." },
  { name: "crm-sync", label: "CRM sync", schedule: "every 30 min", does: "Pulls projects from the CRM connector (REST / MCP). Manual and webhook modes are no-ops." },
  { name: "intake-log", label: "Intake log", schedule: "16:45 Mon–Fri", does: "Posts the day's intake summary to the briefs channel." },
  { name: "approvals-remind", label: "Approval reminders", schedule: "with intake-log", does: "Reminds the approvers of new-supplier approvals still waiting." },
  { name: "reports", label: "Reports refresh", schedule: "on demand", does: "Rebuilds the finance reports from the store." },
] as const;

export function JobsHealth({ status, loading, onReload }: { status: StatusResponse | null; loading: boolean; onReload: () => void }) {
  const [running, setRunning] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Record<string, { ok: boolean; text: string; at: string }>>({});
  const [secretNeeded, setSecretNeeded] = React.useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const curl = (job: string) => `curl -H "Authorization: Bearer $CRON_SECRET" "${origin || "<APP_URL>"}/api/cron?job=${job}"`;

  const run = async (job: string) => {
    setRunning(job);
    try {
      const d = await api<CronResponse>(`/api/cron?job=${encodeURIComponent(job)}`);
      const r = d.results?.[job];
      const ok = !(r && typeof r === "object" && "ok" in r && (r as { ok: unknown }).ok === false);
      setResults((x) => ({ ...x, [job]: { ok, text: JSON.stringify(r ?? d, null, 2), at: new Date().toISOString() } }));
      toast[ok ? "success" : "error"](`${job}: ${ok ? "done" : "failed"} in ${d.ms} ms`);
      onReload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setSecretNeeded(true); toast.error("CRON_SECRET is set — run the job from a terminal (curl shown below)"); }
      else toast.error(e instanceof Error ? e.message : "Run failed");
    } finally { setRunning(null); }
  };

  const s = status?.setup; const q = status?.quickbooks; const crm = status?.crm;
  return (
    <div className="space-y-4">
      <Section icon={Activity} title="Health" hint="What the agents can reach right now. Each card links to the setup step that fixes it." actions={<RefreshButton onClick={onReload} loading={loading} />}>
        {!status ? <p className="text-sm text-muted-foreground">Loading…</p> : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Health icon={Link2} ok={!!q?.connected} title="QuickBooks" href="/setup?step=quickbooks" detail={q ? (q.connected ? `${q.companyName || q.realm} · ${q.posting ? "posting on" : "dry run"}` : q.configured ? `${q.tokenStatus || "not connected"}${q.error ? ` · ${q.error}` : ""}` : "not configured") : "—"} />
            <Health icon={Inbox} ok={!!s?.mail.configured} title="Mailboxes" href="/setup?step=mailboxes" detail={s ? (s.mail.configured ? `${s.mail.provider} · ${s.mail.intake.length} intake · ${s.mail.orders.length} orders${s.mail.accounts ? ` · accounts ${s.mail.accounts}` : ""}` : "not configured") : "—"} />
            <Health icon={FolderSync} ok={!!s?.crm.configured && (crm ? crm.ok : true)} title={`CRM (${s?.crm.mode || "manual"})`} href="/setup?step=crm" detail={crm ? `${crm.ok ? "last sync ok" : "last sync failed"} ${fmtWhen(crm.at)} · ${crm.upserted}/${crm.fetched} projects${crm.errors.length ? ` · ${crm.errors.length} errors` : ""}` : s?.crm.mode === "manual" ? "projects kept in this app" : "never synced"} />
            <Health icon={KeyRound} ok={!!s?.ai.configured} title="AI extractor" href="/setup?step=ai" detail={s ? (s.ai.configured ? `${s.ai.extractor} key set` : "no key — extraction is off") : "—"} />
            <Health icon={Database} ok={!!s?.appSecret} title="Store" href="/setup" detail={s ? `${s.store === "postgres" ? "Postgres" : "local file"} · APP_SECRET ${s.appSecret ? "set" : "missing"}` : "—"} />
            {s?.envOverrides.length ? <div className="rounded-lg border border-border/60 p-3 text-xs sm:col-span-2 lg:col-span-3"><p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Set by environment (wins over Setup)</p><div className="flex flex-wrap gap-1">{s.envOverrides.map((k) => <Badge key={k} variant="secondary" className="font-mono text-[10px]">{k}</Badge>)}</div></div> : null}
          </div>
        )}
      </Section>

      <Section icon={Terminal} title="Scheduled jobs" hint="Vercel Cron (vercel.json) or `npm run scheduler` locally. Every job is idempotent; running one by hand is safe.">
        {secretNeeded ? <ErrorNote>CRON_SECRET is set on this deployment, so the browser cannot call /api/cron. Run jobs from a terminal with the curl on each row (the scheduler script does the same).</ErrorNote> : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-xs">
            <thead className={THEAD}><tr><TH>Job</TH><TH>Schedule</TH><TH>Last run here</TH><TH /></tr></thead>
            <tbody>
              {JOBS.map((j) => {
                const r = results[j.name];
                return (
                  <React.Fragment key={j.name}>
                    <tr className="border-b border-border/40 align-top">
                      <td className="p-2"><p className="font-medium">{j.label} <span className="font-mono text-[10px] text-muted-foreground">{j.name}</span></p><p className="text-muted-foreground">{j.does}</p></td>
                      <td className="whitespace-nowrap p-2 text-muted-foreground">{j.schedule}</td>
                      <td className="p-2">{r ? <span className={cn("inline-flex items-center gap-1", r.ok ? "text-emerald-600" : "text-red-500")}>{r.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />} {fmtWhen(r.at)}</span> : <span className="text-muted-foreground">—</span>}</td>
                      <td className="p-2 text-right">
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button size="sm" className="h-7 gap-1 text-xs" disabled={!!running || secretNeeded} onClick={() => run(j.name)}><Play className={cn("h-3 w-3", running === j.name && "animate-pulse")} /> {running === j.name ? "Running…" : "Run now"}</Button>
                          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" title={curl(j.name)} onClick={async () => { if (await copyText(curl(j.name))) toast.success("curl copied"); }}><Terminal className="h-3 w-3" /> curl</Button>
                        </div>
                      </td>
                    </tr>
                    {r ? <tr className="border-b border-border/40 bg-muted/10"><td colSpan={4} className="p-2"><pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 text-[10px]">{r.text}</pre></td></tr> : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Running jobs from a terminal</summary>
          <pre className="mt-1 overflow-x-auto rounded bg-muted/40 p-2 text-[11px]">{`# any job, with the secret from .env.local (omit the header when CRON_SECRET is unset)\n${curl("intake")}\n\n# the local scheduler runs the same timetable as vercel.json\nnpm run scheduler`}</pre>
          <p className="mt-1 text-muted-foreground">The agents themselves run from cron with <code>scripts/run-agent.sh &lt;agent&gt;</code> — see the <Link className="underline" href="/finance?tab=agents&view=agents">Agents</Link> view.</p>
        </details>
      </Section>
    </div>
  );
}

function Health({ icon: Icon, ok, title, detail, href }: { icon: React.ComponentType<{ className?: string }>; ok: boolean; title: string; detail: string; href: string }) {
  return (
    <Link href={href} className={cn("flex items-start gap-2 rounded-lg border p-3 text-xs transition-colors hover:bg-muted/40", ok ? "border-emerald-500/30" : "border-amber-500/40")}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", ok ? "text-emerald-600" : "text-amber-600")} />
      <div className="min-w-0"><p className="font-medium">{title} <span className={cn("ml-1 text-[10px]", ok ? "text-emerald-600" : "text-amber-600")}>{ok ? "ok" : "attention"}</span></p><p className="truncate text-muted-foreground" title={detail}>{detail}</p></div>
    </Link>
  );
}
