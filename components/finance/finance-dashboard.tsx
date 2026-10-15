"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Landmark, Coins, AlertTriangle, CalendarClock, FileText, ChevronDown, ChevronUp, CheckCircle2, ExternalLink, Search, RefreshCw, Pencil, Trash2, ShieldCheck, Bot } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PAYMENT_CONFIRMATION_LABEL, type Invoice } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import { useApi, useMoney } from "@/components/use-api";
import { LineStatusChip, InvoiceStatusChip } from "./status-chip";
import { PnlCompareStrip } from "./pnl-compare-strip";
import { EditInvoiceDialog } from "./edit-invoice-dialog";
import { DeleteInvoiceDialog } from "./delete-invoice-dialog";
import { InvoiceActions } from "./invoice-actions";
import { FinanceAgentsPanel, isAgentView, type AgentBadges, type AgentView } from "./finance-agents-panel";
import { ErrorNote, Empty } from "./section";
import { fmtDate, personName } from "./money";
import type { CollectionRow, DueLine, FinanceOverview, InvoiceRow, PnlRow, StatusResponse } from "./types";

const TABS = ["collections", "invoices", "pnl", "agents"] as const;
type Tab = (typeof TABS)[number];
const isTab = (v: string | null | undefined): v is Tab => !!v && (TABS as readonly string[]).includes(v);
const LS_TAB = "finance.tab", LS_VIEW = "finance.view";
const remembered = (key: string) => { try { return typeof window !== "undefined" ? window.localStorage.getItem(key) : null; } catch { return null; } };
const remember = (key: string, value: string) => { try { window.localStorage.setItem(key, value); } catch { /* private mode */ } };

function Kpi({ label, value, sub, icon: Icon, tone = "default" }: { label: string; value: string; sub?: string; icon?: typeof Landmark; tone?: "default" | "money" | "red" | "green" }) {
  return (
    <Card className="p-4">
      <p className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">{Icon ? <Icon className={cn("h-3 w-3", tone === "money" ? "text-money" : tone === "red" ? "text-red-500" : tone === "green" ? "text-green-600" : "")} /> : null} {label}</p>
      <p className={cn("font-display text-2xl font-bold tabular-nums", tone === "money" && "text-money", tone === "red" && "text-red-500", tone === "green" && "text-green-600 dark:text-green-400")}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p> : null}
    </Card>
  );
}

function DueList({ rows, empty }: { rows: DueLine[]; empty: string }) {
  const { money } = useMoney();
  if (!rows.length) return <p className="py-4 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="space-y-1.5">
      {rows.map((l) => (
        <Link key={`${l.projectId}-${l.key}`} href={`/projects/${encodeURIComponent(l.projectId)}`} className="flex items-center gap-3 rounded-lg bg-muted/30 p-2.5 text-sm transition-colors hover:bg-muted/50">
          <div className="min-w-0 flex-1"><p className="truncate font-medium">{l.client}</p><p className="truncate text-[11px] text-muted-foreground">{l.label} · {personName(l.designer)}{l.opsStage ? ` · ${l.opsStage}` : ""}</p></div>
          <div className="shrink-0 text-right"><p className="font-semibold tabular-nums">{money(l.outstandingGross)}</p><p className="text-[11px] text-muted-foreground">{l.dueDate ? fmtDate(l.dueDate) : "date TBC"}</p></div>
          <div className="flex shrink-0 flex-col items-end gap-1"><LineStatusChip status={l.status} />{l.invoiceNumber ? <span className="text-[10px] text-muted-foreground">{l.invoiceNumber}</span> : <span className="text-[10px] text-amber-600">not invoiced</span>}</div>
        </Link>
      ))}
    </div>
  );
}

export function FinanceDashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { money } = useMoney();
  const overviewApi = useApi<FinanceOverview>("/api/finance/overview");
  const statusApi = useApi<StatusResponse>("/api/finance/status");
  // Badge counts for the Finance Agents tab. Each read is independent and optional.
  const intakeApi = useApi<{ counts: Record<string, number> }>("/api/finance/intake?state=open&limit=1");
  const acksApi = useApi<{ counts: Record<string, number> }>("/api/finance/orders-intake?state=open&limit=1");
  const disputesApi = useApi<{ total: number }>("/api/finance/disputes?status=active");
  const badges: AgentBadges = { intakeOpen: (intakeApi.data?.counts.proposed || 0) + (intakeApi.data?.counts.held || 0), acksOpen: acksApi.data?.counts.unmatched || 0, disputesOpen: disputesApi.data?.total || 0 };

  // The open tab and Finance Agents view live in the URL (?tab=agents&view=…)
  // so links from briefs land on the right place; the last choice is
  // remembered per browser for plain /finance.
  const urlTab = params.get("tab");
  const urlView = params.get("view");
  const [tab, setTabState] = React.useState<Tab>(() => (isTab(urlTab) ? urlTab : isTab(remembered(LS_TAB)) ? (remembered(LS_TAB) as Tab) : "collections"));
  const [view, setViewState] = React.useState<AgentView>(() => (isAgentView(urlView) ? urlView : isAgentView(remembered(LS_VIEW)) ? (remembered(LS_VIEW) as AgentView) : "cashflow"));
  React.useEffect(() => { if (isTab(urlTab)) setTabState(urlTab); if (isAgentView(urlView)) setViewState(urlView); }, [urlTab, urlView]);
  const syncUrl = React.useCallback((t: Tab, v: AgentView) => {
    const q = new URLSearchParams(params.toString());
    q.set("tab", t); if (t === "agents") q.set("view", v); else q.delete("view");
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  }, [params, pathname, router]);
  const setTab = (t: string) => { const next = isTab(t) ? t : "collections"; setTabState(next); remember(LS_TAB, next); syncUrl(next, view); };
  const setView = (v: AgentView) => { setViewState(v); remember(LS_VIEW, v); syncUrl("agents", v); };
  React.useEffect(() => { if (params.get("connected") === "1") toast.success("QuickBooks connected"); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => { overviewApi.reload(); statusApi.reload(); intakeApi.reload(); acksApi.reload(); disputesApi.reload(); };
  const overview = overviewApi.data;
  const kpis = overview?.kpis;
  const overdue = overview ? overview.dueLines.filter((l) => l.status === "overdue") : [];
  const soon = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const dueSoon = overview ? overview.dueLines.filter((l) => l.status === "due" || (l.status === "upcoming" && l.dueDate && l.dueDate <= soon)) : [];
  const attention = badges.intakeOpen + badges.acksOpen + badges.disputesOpen;
  const q = statusApi.data?.quickbooks;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10"><Landmark className="h-5 w-5 text-primary" /></div>
          <div>
            <h1 className="text-xl font-bold">Finance</h1>
            <p className="text-sm text-muted-foreground">Collections, invoices and profit across {overview ? `${overview.projects} project${overview.projects === 1 ? "" : "s"}` : "your projects"} · supplier side and the F0–F9 agents under Finance Agents</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => { setTab("agents"); }} title="Open the QuickBooks connection card" className="rounded-full">
            <Badge className={cn("cursor-pointer border-0", q?.connected ? "bg-green-500/15 text-green-600 hover:bg-green-500/25 dark:text-green-400" : "bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300")}>QuickBooks {q ? (q.connected ? "connected" : q.configured ? "not connected" : "not configured") : "…"}</Badge>
          </button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={refresh} disabled={overviewApi.loading}><RefreshCw className={cn("h-3.5 w-3.5", overviewApi.loading && "animate-spin")} /> Refresh</Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">Project schedules and recorded receipts — not bank-reconciled cash; the person marking an invoice paid states how the receipt was verified. Sales / Order / Supplier P&amp;L use project costs; Completion uses the supplier invoices in QuickBooks. Never use this balance as available-to-pay.</p>
      {overviewApi.error ? <ErrorNote>Overview unavailable: {overviewApi.error}</ErrorNote> : null}
      {overview && (!overview.pnlCoverage.snapshotsAvailable || overview.pnlCoverage.truncated) ? <p role="status" className="text-sm text-amber-700 dark:text-amber-300">P&amp;L coverage incomplete: {overview.pnlCoverage.loaded} of {overview.pnlCoverage.eligible} projects loaded.{!overview.pnlCoverage.snapshotsAvailable ? " Cost snapshots unavailable; live estimates shown." : ""}</p> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Contract value inc VAT" value={kpis ? money(kpis.contractGross) : "—"} sub={kpis ? `${money(kpis.contractNet)} net` : undefined} icon={Coins} />
        <Kpi label="Recorded receipts" value={kpis ? money(kpis.taken) : "—"} sub={kpis && kpis.contractGross ? `${Math.round((kpis.taken / kpis.contractGross) * 100)}% recorded` : undefined} tone="green" icon={CheckCircle2} />
        <Kpi label="Outstanding" value={kpis ? money(kpis.outstanding) : "—"} tone="money" icon={Coins} sub={kpis ? `${money(kpis.uninvoicedDue)} due but not invoiced` : undefined} />
        <Kpi label="Overdue" value={kpis ? money(kpis.overdue) : "—"} tone="red" icon={AlertTriangle} sub={`${overdue.length} line${overdue.length === 1 ? "" : "s"}`} />
        <Kpi label="Due next 14 days" value={kpis ? money(kpis.dueNext14) : "—"} icon={CalendarClock} sub={kpis ? `${money(kpis.dueNext30)} in 30 days` : undefined} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 h-auto w-full flex-wrap justify-start sm:w-auto">
          <TabsTrigger value="collections">Collections</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="pnl">P&amp;L</TabsTrigger>
          <TabsTrigger value="agents"><span className="inline-flex items-center gap-1.5"><Bot className="h-3.5 w-3.5" /> Finance Agents{attention > 0 ? <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold tabular-nums text-amber-700 dark:text-amber-300" title={`${badges.intakeOpen} supplier invoices to review · ${badges.acksOpen} acknowledgements to match · ${badges.disputesOpen} open disputes`}>{attention}</span> : null}</span></TabsTrigger>
        </TabsList>

        <TabsContent value="collections">
          {overview ? (
            <div className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="p-4"><h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-red-500" /> Overdue</h3><DueList rows={overdue.slice(0, 8)} empty="Nothing overdue" />{overdue.length > 8 ? <p className="mt-2 text-xs text-muted-foreground">{overdue.length - 8} more below</p> : null}</Card>
                <Card className="p-4"><h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><CalendarClock className="h-4 w-4 text-amber-600" /> Due in the next 14 days</h3><DueList rows={dueSoon.slice(0, 8)} empty="Nothing falls due in the next fortnight" /></Card>
              </div>
              <CollectionsTab rows={overview.collections} />
            </div>
          ) : <Card className="p-6 text-sm text-muted-foreground">{overviewApi.loading ? "Loading…" : "No data."}</Card>}
        </TabsContent>
        <TabsContent value="invoices">{overview ? <InvoicesTab rows={overview.invoices} kpis={overview.kpis} onChanged={refresh} /> : <Card className="p-6 text-sm text-muted-foreground">{overviewApi.loading ? "Loading…" : "No data."}</Card>}</TabsContent>
        <TabsContent value="pnl">{overview ? <PnlTab rows={overview.pnl} kpis={overview.kpis} /> : <Card className="p-6 text-sm text-muted-foreground">{overviewApi.loading ? "Loading…" : "No data."}</Card>}</TabsContent>
        <TabsContent value="agents"><FinanceAgentsPanel status={statusApi.data} statusLoading={statusApi.loading} onStatusReload={statusApi.reload} view={view} onViewChange={setView} badges={badges} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
function CollectionsTab({ rows }: { rows: CollectionRow[] }) {
  const { money, money2 } = useMoney();
  const [q, setQ] = React.useState("");
  const [designer, setDesigner] = React.useState("all");
  const [stage, setStage] = React.useState("all");
  const [sort, setSort] = React.useState<"outstanding" | "overdue" | "nextDue" | "client">("outstanding");
  const [open, setOpen] = React.useState<string | null>(null);
  const designers = Array.from(new Set(rows.map((r) => r.designer).filter(Boolean))) as string[];
  const stages = Array.from(new Set(rows.map((r) => r.opsStage).filter(Boolean))) as string[];
  const filtered = rows
    .filter((r) => (!q || r.client.toLowerCase().includes(q.toLowerCase())) && (designer === "all" || r.designer === designer) && (stage === "all" || r.opsStage === stage))
    .sort((a, b) => sort === "client" ? a.client.localeCompare(b.client) : sort === "overdue" ? b.overdue - a.overdue : sort === "nextDue" ? (a.nextDue?.dueDate || "9999").localeCompare(b.nextDue?.dueDate || "9999") : b.outstanding - a.outstanding);
  const total = filtered.reduce((s, r) => ({ gross: s.gross + r.gross, taken: s.taken + r.taken, outstanding: s.outstanding + r.outstanding }), { gross: 0, taken: 0, outstanding: 0 });
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative"><Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input className="h-9 w-48 pl-8" placeholder="Search client" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {designers.length ? <Select value={designer} onValueChange={setDesigner}><SelectTrigger className="h-9 w-40" aria-label="Salesperson"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All salespeople</SelectItem>{designers.map((d) => <SelectItem key={d} value={d}>{personName(d)}</SelectItem>)}</SelectContent></Select> : null}
        {stages.length ? <Select value={stage} onValueChange={setStage}><SelectTrigger className="h-9 w-40" aria-label="Stage"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All stages</SelectItem>{stages.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select> : null}
        <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}><SelectTrigger className="h-9 w-44" aria-label="Sort"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="outstanding">Most outstanding</SelectItem><SelectItem value="overdue">Most overdue</SelectItem><SelectItem value="nextDue">Next due first</SelectItem><SelectItem value="client">Client A–Z</SelectItem></SelectContent></Select>
        <span className="ml-auto text-xs text-muted-foreground">{filtered.length} projects · {money(total.outstanding)} outstanding of {money(total.gross)}</span>
      </div>
      {filtered.length === 0 ? <Empty>No projects match. Add projects under Projects, or connect your CRM in Setup.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-border/60 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr><th className="p-2 text-left font-medium">Client</th><th className="p-2 text-left font-medium">Stage</th><th className="p-2 text-left font-medium">Salesperson</th><th className="p-2 text-right font-medium">Inc VAT</th><th className="p-2 text-right font-medium">Taken</th><th className="p-2 text-right font-medium">Outstanding</th><th className="p-2 text-left font-medium">Next due · date</th><th className="p-2 text-left font-medium">Invoices</th><th className="p-2" /></tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <React.Fragment key={r.projectId}>
                  <tr className={cn("cursor-pointer border-b border-border/40 hover:bg-muted/30", open === r.projectId && "bg-muted/20")} onClick={() => setOpen(open === r.projectId ? null : r.projectId)}>
                    <td className="p-2 font-medium">{r.client}</td>
                    <td className="p-2 text-xs text-muted-foreground">{r.opsStage || "—"}</td>
                    <td className="p-2 text-xs text-muted-foreground">{personName(r.designer)}</td>
                    <td className="p-2 text-right tabular-nums">{money(r.gross)}</td>
                    <td className="p-2 text-right tabular-nums text-money">{money(r.taken)}</td>
                    <td className={cn("p-2 text-right font-semibold tabular-nums", r.outstanding > 0 ? (r.overdue > 0 ? "text-red-500" : "") : "text-green-600")}>{money(r.outstanding)}{r.overdue > 0 ? <span className="block text-[10px] font-normal text-red-500">{money(r.overdue)} overdue</span> : null}</td>
                    <td className="p-2 text-xs">{r.nextDue ? <span className="flex flex-col gap-0.5"><span className="flex items-center gap-1.5">{r.nextDue.label} · {money(r.nextDue.outstandingGross)} <LineStatusChip status={r.nextDue.status} /></span><span className={cn("text-[11px] tabular-nums", r.nextDue.status === "overdue" ? "text-red-500" : "text-muted-foreground")}>{r.nextDue.dueDate ? fmtDate(r.nextDue.dueDate) : "date TBC"}</span></span> : <span className="text-green-600">All paid</span>}</td>
                    <td className="p-2 text-xs text-muted-foreground">{r.invoices.total ? `${r.invoices.paid} paid · ${r.invoices.sent} sent · ${r.invoices.draft} draft` : "none"}</td>
                    <td className="p-2 text-right">{open === r.projectId ? <ChevronUp className="inline h-4 w-4" /> : <ChevronDown className="inline h-4 w-4" />}</td>
                  </tr>
                  {open === r.projectId ? (
                    <tr className="border-b border-border/40 bg-muted/10"><td colSpan={9} className="p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">Payment schedule · won {fmtDate(r.wonDate)} · {money(r.net)} net</p>
                        <Link href={`/projects/${encodeURIComponent(r.projectId)}`} className="flex items-center gap-1 text-xs text-primary hover:underline"><ExternalLink className="h-3 w-3" /> Open project</Link>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                        {r.lines.filter((l) => l.applicable).map((l) => (
                          <div key={l.key} className="rounded-lg border border-border/60 bg-card p-2.5 text-xs">
                            <div className="flex items-center justify-between gap-2"><span className="font-medium">{l.label}</span><LineStatusChip status={l.status} /></div>
                            <p className="mt-1 font-semibold tabular-nums">{money2(l.amountGross)}{l.paidGross > 0 && l.status !== "paid" ? <span className="font-normal text-muted-foreground"> · {money(l.paidGross)} paid</span> : null}</p>
                            <p className="text-muted-foreground">{l.dueDate ? `Due ${fmtDate(l.dueDate)}` : l.trigger}{l.invoice ? ` · ${l.invoice.number}` : ""}</p>
                          </div>
                        ))}
                      </div>
                    </td></tr>
                  ) : null}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
function InvoicesTab({ rows, kpis, onChanged }: { rows: InvoiceRow[]; kpis: FinanceOverview["kpis"]; onChanged: () => void }) {
  const { money, money2 } = useMoney();
  const [status, setStatus] = React.useState("open");
  const [editFor, setEditFor] = React.useState<{ projectId: string; invoice: Invoice } | null>(null);
  const [deleteFor, setDeleteFor] = React.useState<{ projectId: string; invoice: Invoice } | null>(null);
  const filtered = rows.filter((r) => status === "all" ? true : status === "open" ? r.invoice.status === "draft" || r.invoice.status === "sent" : r.invoice.status === status);
  const total = filtered.reduce((s, r) => s + r.gross, 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {(["draft", "sent", "paid"] as const).map((s) => (
          <div key={s} className={cn("rounded-lg p-3 text-center", s === "paid" ? "bg-green-500/10" : s === "sent" ? "bg-blue-500/10" : "bg-muted/40")}>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{s}</p>
            <p className="font-display text-lg font-bold">{kpis.invoices[s].count}</p>
            <p className="text-[11px] text-muted-foreground">{money(kpis.invoices[s].value)}</p>
          </div>
        ))}
      </div>
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select value={status} onValueChange={setStatus}><SelectTrigger className="h-9 w-44" aria-label="Status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="open">Open (draft + sent)</SelectItem><SelectItem value="draft">Draft</SelectItem><SelectItem value="sent">Sent</SelectItem><SelectItem value="paid">Paid</SelectItem><SelectItem value="void">Void</SelectItem><SelectItem value="all">All</SelectItem></SelectContent></Select>
          <span className="ml-auto text-xs text-muted-foreground">{filtered.length} invoice{filtered.length === 1 ? "" : "s"} · {money(total)}</span>
        </div>
        <p className="mb-3 text-[11px] text-muted-foreground">{money(kpis.uninvoicedDue)} of due/overdue payments have no invoice yet — raise them from the project&apos;s payment schedule.</p>
        {filtered.length === 0 ? <Empty icon={FileText}>No invoices in this view. Raise them from a project&apos;s payment schedule.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr><th className="p-2 text-left font-medium">Invoice</th><th className="p-2 text-left font-medium">Client</th><th className="p-2 text-left font-medium">For</th><th className="p-2 text-left font-medium">Date</th><th className="p-2 text-left font-medium">Due</th><th className="p-2 text-right font-medium">Inc VAT</th><th className="p-2 text-left font-medium">Status</th><th className="p-2" /></tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.invoice.id} className="border-b border-border/40">
                    <td className="p-2 font-medium"><FileText className="mr-1 inline h-3.5 w-3.5 text-primary" />{r.invoice.number}</td>
                    <td className="p-2"><Link href={`/projects/${encodeURIComponent(r.projectId)}`} className="hover:underline">{r.client}</Link><span className="block text-[11px] text-muted-foreground">{personName(r.designer)}</span></td>
                    <td className="p-2 text-xs text-muted-foreground">{r.lineLabel || r.invoice.items[0]?.description || "—"}</td>
                    <td className="p-2 text-xs">{fmtDate(r.invoice.date)}</td>
                    <td className={cn("p-2 text-xs", r.overdue && "font-medium text-red-500")}>{fmtDate(r.invoice.dueDate)}{r.overdue ? " · overdue" : ""}</td>
                    <td className="p-2 text-right font-semibold tabular-nums">{money2(r.gross)}</td>
                    <td className="p-2"><InvoiceStatusChip status={r.invoice.status} />{r.invoice.status === "paid" ? (r.confirmation ? <span className="mt-0.5 flex items-center gap-1 text-[10px] text-emerald-700 dark:text-emerald-400" title={`${PAYMENT_CONFIRMATION_LABEL[r.confirmation.source]} · ${r.confirmation.by}${r.confirmation.ref ? ` · ${r.confirmation.ref}` : ""}`}><ShieldCheck className="h-3 w-3" /> {PAYMENT_CONFIRMATION_LABEL[r.confirmation.source]}</span> : <span className="mt-0.5 block text-[10px] text-amber-600" title="Marked paid before receipt confirmation was recorded">receipt unconfirmed</span>) : null}</td>
                    <td className="p-2">
                      <div className="flex items-center justify-end gap-1">
                        {(r.invoice.status === "draft" || r.invoice.status === "sent") ? <Button variant="ghost" size="icon-sm" className="h-7 w-7" title="Edit invoice" aria-label={`Edit ${r.invoice.number}`} onClick={() => setEditFor({ projectId: r.projectId, invoice: r.invoice })}><Pencil className="h-3.5 w-3.5" /></Button> : null}
                        <InvoiceActions projectId={r.projectId} invoice={r.invoice} compact onChanged={onChanged} onEdit={(inv) => setEditFor({ projectId: r.projectId, invoice: inv })} onDelete={(inv) => setDeleteFor({ projectId: r.projectId, invoice: inv })} />
                        {r.invoice.status !== "paid" ? <Button variant="ghost" size="icon-sm" className="h-7 w-7 text-muted-foreground hover:text-red-500" title={`Delete ${r.invoice.number}`} aria-label={`Delete ${r.invoice.number}`} onClick={() => setDeleteFor({ projectId: r.projectId, invoice: r.invoice })}><Trash2 className="h-3.5 w-3.5" /></Button> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <EditInvoiceDialog open={!!editFor} onOpenChange={(o) => !o && setEditFor(null)} projectId={editFor?.projectId || ""} invoice={editFor?.invoice || null} onSaved={onChanged} />
        <DeleteInvoiceDialog open={!!deleteFor} onOpenChange={(o) => !o && setDeleteFor(null)} projectId={deleteFor?.projectId || ""} invoice={deleteFor?.invoice || null} onDeleted={onChanged} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
function MarginChip({ pct, available, frozen }: { pct: number; available: boolean; frozen: boolean }) {
  if (!available) return <span className="text-[11px] text-muted-foreground">—</span>;
  return <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums", pct >= 35 ? "bg-green-500/15 text-green-600" : pct >= 25 ? "bg-amber-500/15 text-amber-600" : "bg-red-500/15 text-red-500")} title={frozen ? "Frozen snapshot" : "Live from the order ledger"}>{pct}%{!frozen ? <span className="ml-1 font-normal opacity-70">live</span> : null}</span>;
}

function PnlTab({ rows, kpis }: { rows: PnlRow[]; kpis: FinanceOverview["kpis"] }) {
  const { money } = useMoney();
  const [open, setOpen] = React.useState<string | null>(null);
  const [sort, setSort] = React.useState<"completion" | "drift" | "client">("drift");
  const drift = (r: PnlRow) => Math.min(...[r.comparison.deltas.orderToSupplier?.marginPts, r.comparison.deltas.orderToCompletion?.marginPts, r.comparison.deltas.salesToOrder?.marginPts].filter((v): v is number => typeof v === "number"), 0);
  const sorted = [...rows].sort((a, b) => sort === "client" ? a.client.localeCompare(b.client) : sort === "completion" ? (b.comparison.completion.available ? b.comparison.completion.marginPct : -999) - (a.comparison.completion.available ? a.comparison.completion.marginPct : -999) : drift(a) - drift(b));
  const totals = rows.reduce((s, r) => ({ sales: s.sales + (r.comparison.sales.available ? r.comparison.sales.profit : 0), order: s.order + (r.comparison.order.available ? r.comparison.order.profit : 0), supplier: s.supplier + (r.comparison.supplier?.available ? r.comparison.supplier.profit : 0), completion: s.completion + (r.comparison.completion.available ? r.comparison.completion.profit : 0), extra: s.extra + r.comparison.extraSpend.total }), { sales: 0, order: 0, supplier: 0, completion: 0, extra: 0 });
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">Project profit estimates</h3>
        <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
          {([["Sales", kpis.pnl.salesProfit, kpis.pnl.salesMargin, kpis.pnl.salesCount], ["Order", kpis.pnl.orderProfit, kpis.pnl.orderMargin, kpis.pnl.orderCount], ["Supplier", kpis.pnl.supplierProfit ?? 0, kpis.pnl.supplierMargin ?? null, kpis.pnl.supplierCount ?? 0], ["Completion", kpis.pnl.completionProfit, kpis.pnl.completionMargin, kpis.pnl.completionCount]] as const).map(([label, profit, margin, count]) => (
            <div key={label} className="rounded-lg bg-muted/40 p-3"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label} P&amp;L</p><p className={cn("font-display text-lg font-bold", profit >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500")}>{money(profit)}</p><p className="text-[11px] text-muted-foreground">{count ? `${margin ?? "—"}% weighted margin · ${count} project${count === 1 ? "" : "s"}` : "not captured"}</p></div>
          ))}
        </div>
      </Card>
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <p className="text-sm text-muted-foreground">Sales = costing at sale · Order = order costing · Supplier = supplier-acknowledged prices incl. carriage (ordered prices until the ack arrives) · Completion = what the suppliers actually invoiced (QuickBooks bills on the project class) + extras, shown once every supplier has invoiced. Net of VAT.</p>
          <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}><SelectTrigger className="ml-auto h-9 w-52" aria-label="Sort"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="drift">Biggest margin drop first</SelectItem><SelectItem value="completion">Best completion margin</SelectItem><SelectItem value="client">Client A–Z</SelectItem></SelectContent></Select>
        </div>
        <div className="mb-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-5">
          {([["Sales profit", totals.sales], ["Order profit", totals.order], ["Supplier profit", totals.supplier], ["Completion profit", totals.completion], ["Remedials + extras", -totals.extra]] as const).map(([label, v]) => (
            <div key={label} className="rounded-lg bg-muted/40 p-3"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className={cn("font-display text-lg font-bold", v >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500")}>{money(v)}</p></div>
          ))}
        </div>
        {rows.length === 0 ? <Empty>No costings captured yet. Costing snapshots come from your CRM or the supplier orders on each project.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr><th className="p-2 text-left font-medium">Client</th><th className="p-2 text-left font-medium">Stage</th><th className="p-2 text-right font-medium">Net value</th><th className="p-2 text-left font-medium">Sales</th><th className="p-2 text-left font-medium">Order</th><th className="p-2 text-left font-medium">Supplier</th><th className="p-2 text-left font-medium">Completion</th><th className="p-2 text-right font-medium">Extra spend</th><th className="p-2" /></tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <React.Fragment key={r.projectId}>
                    <tr className={cn("cursor-pointer border-b border-border/40 hover:bg-muted/30", open === r.projectId && "bg-muted/20")} onClick={() => setOpen(open === r.projectId ? null : r.projectId)}>
                      <td className="p-2 font-medium">{r.client}<span className="block text-[11px] font-normal text-muted-foreground">{personName(r.designer)}</span></td>
                      <td className="p-2 text-xs text-muted-foreground">{r.opsStage || "—"}</td>
                      <td className="p-2 text-right tabular-nums">{money(r.net)}</td>
                      <td className="p-2"><MarginChip pct={r.comparison.sales.marginPct} available={r.comparison.sales.available} frozen={r.comparison.sales.frozen} /><span className="block text-[11px] text-muted-foreground">{r.comparison.sales.available ? money(r.comparison.sales.profit) : ""}</span></td>
                      <td className="p-2"><MarginChip pct={r.comparison.order.marginPct} available={r.comparison.order.available} frozen={r.comparison.order.frozen} /><span className="block text-[11px] text-muted-foreground">{r.comparison.order.available ? money(r.comparison.order.profit) : ""}</span></td>
                      <td className="p-2"><MarginChip pct={r.comparison.supplier?.marginPct ?? 0} available={!!r.comparison.supplier?.available} frozen={false} /><span className={cn("block text-[11px]", r.comparison.supplierDrift && r.comparison.supplierDrift.delta > 0 ? "text-amber-600" : "text-muted-foreground")}>{r.comparison.supplier?.available ? (r.comparison.supplierDrift ? `${r.comparison.supplierDrift.delta >= 0 ? "+" : "−"}${money(Math.abs(r.comparison.supplierDrift.delta))} vs ordered` : "no ack yet · ordered prices") : ""}</span></td>
                      <td className="max-w-[220px] p-2"><MarginChip pct={r.comparison.completion.marginPct} available={r.comparison.completion.available} frozen={r.comparison.completion.frozen} /><span className={cn("block truncate text-[11px]", r.comparison.completion.available ? "text-muted-foreground" : "text-amber-700/80 dark:text-amber-300/80")} title={r.comparison.completion.source || ""}>{r.comparison.completion.available ? money(r.comparison.completion.profit) : r.comparison.completion.source?.startsWith("Awaiting") ? "awaiting supplier invoices" : r.comparison.completion.source ? "ledger unavailable" : ""}</span></td>
                      <td className={cn("p-2 text-right text-xs tabular-nums", r.comparison.extraSpend.total > 0 ? "text-orange-600" : "text-muted-foreground")}>{r.comparison.extraSpend.total > 0 ? money(r.comparison.extraSpend.total) : "—"}</td>
                      <td className="p-2 text-right">{open === r.projectId ? <ChevronUp className="inline h-4 w-4" /> : <ChevronDown className="inline h-4 w-4" />}</td>
                    </tr>
                    {open === r.projectId ? <tr className="border-b border-border/40 bg-muted/10"><td colSpan={9} className="p-3"><PnlCompareStrip comparison={r.comparison} /><Link href={`/projects/${encodeURIComponent(r.projectId)}`} className="mt-2 flex items-center gap-1 text-xs text-primary hover:underline"><ExternalLink className="h-3 w-3" /> Open project</Link></td></tr> : null}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
