"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, FileText, Inbox, AlertTriangle, CheckCircle2, PauseCircle, XCircle, Copy, Play, Bot, Pencil, Save, History, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api, useApi, useCompany, useMoney } from "@/components/use-api";
import { Section, Notice, ErrorNote, RefreshButton, Empty, TH, THEAD, select } from "./section";
import { fmtDay, fmtWhen, pct } from "./money";
import type { AutopilotConfig, AutopilotMode, AutopilotResponse, DecisionsResponse, IntakeListResponse, IntakeOptions, IntakeRecord, IntakeRunSummary, IntakeState, PostedEdit, ResolveOverrides } from "./types";

// Supplier invoices: the review queue for PDFs found in the intake mailboxes.
// Everything the resolver could not decide is shown with its reason; a human
// fixes vendor / account / class inline and posts (or holds / rejects).
// While posting is off the whole panel is a dry run. The Autopilot switch
// (manual / assisted / full), the Decisions tab and "Edit in QuickBooks" on
// posted rows are the learning loop's controls.

type PostedEditDraft = { lines: Record<number, { accountId?: string | null; classId?: string | null; taxCodeId?: string | null }>; dueDate?: string; docNumber?: string; privateNote?: string };

const MODES: { key: AutopilotMode; label: string; hint: string }[] = [
  { key: "manual", label: "Manual", hint: "Nothing posts without a human: every item waits in this queue and you press Post." },
  { key: "assisted", label: "Assisted", hint: "Auto-posts only suppliers on auto-post (earned by three agreeing posts in a row, or ticked in the playbook) when the coding is certain and classed." },
  { key: "full", label: "Full", hint: "Auto-posts every item with confidence at or above the minimum, a resolved class and a known supplier; the rest still waits here." },
];
type StateKey = IntakeState | "open" | "decisions";
const STATES: { key: StateKey; label: string }[] = [
  { key: "open", label: "To review" }, { key: "proposed", label: "Proposed" }, { key: "held", label: "Held" }, { key: "posted", label: "Posted" }, { key: "duplicate", label: "Duplicates" }, { key: "not_invoice", label: "Not invoices" }, { key: "rejected", label: "Rejected" },
];
const short = (mb: string) => mb.split("@")[0];

function StateBadge({ state }: { state: IntakeState }) {
  const tone: Record<IntakeState, string> = {
    proposed: "bg-amber-500/15 text-amber-700 dark:text-amber-400", held: "bg-muted text-muted-foreground", posted: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    rejected: "bg-red-500/15 text-red-600", duplicate: "bg-muted text-muted-foreground line-through", not_invoice: "bg-muted text-muted-foreground",
  };
  return <Badge className={cn("border-0 text-[10px] uppercase tracking-wide", tone[state])}>{state.replace("_", " ")}</Badge>;
}
function Confidence({ v, reasons }: { v: number; reasons: string[] }) {
  return <span className={cn("font-semibold tabular-nums", v >= 0.9 ? "text-emerald-600" : v >= 0.7 ? "text-amber-600" : "text-red-500")} title={reasons.join(", ")}>{pct(v)}</span>;
}

// ------------------------------------------------------------ autopilot
function AutopilotControl({ data, admin, onChange, busy }: { data: AutopilotResponse | null; admin: boolean; onChange: (patch: Partial<AutopilotConfig>) => void; busy: boolean }) {
  const cfg = data?.autopilot;
  const mode = cfg?.mode || "manual";
  const [minConf, setMinConf] = React.useState<string>("");
  const cfgMin = cfg?.minConfidence;
  React.useEffect(() => { if (cfgMin != null) setMinConf(String(cfgMin)); }, [cfgMin]);
  const tone = mode === "full" ? "border-emerald-500/40 bg-emerald-500/5" : mode === "assisted" ? "border-sky-500/40 bg-sky-500/5" : "border-border/60 bg-muted/20";
  return (
    <div className={cn("mb-3 rounded-lg border p-2.5 text-xs", tone)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 font-semibold"><Bot className="h-3.5 w-3.5" /> Autopilot</span>
        <div className="inline-flex overflow-hidden rounded-full border border-border/60">
          {MODES.map((m) => (
            <button key={m.key} type="button" disabled={!admin || busy || !data} title={admin ? m.hint : "Only the owner changes the autopilot mode"} onClick={() => mode !== m.key && onChange({ mode: m.key })}
              className={cn("h-6 px-2.5 text-[11px] transition-colors", mode === m.key ? "bg-foreground text-background" : "hover:bg-muted/40", !admin && "cursor-default")}>{m.label}</button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1 text-[11px]">min confidence
          <input type="number" step="0.05" min="0.5" max="1" value={minConf} disabled={!admin || busy || !data} onChange={(e) => setMinConf(e.target.value)} onBlur={() => { const n = parseFloat(minConf); if (cfg && Number.isFinite(n) && n !== cfg.minConfidence && n >= 0.5 && n <= 1) onChange({ minConfidence: n }); else if (cfg) setMinConf(String(cfg.minConfidence)); }}
            className="h-6 w-16 rounded border border-border/60 bg-background px-1.5 text-xs tabular-nums" />
        </label>
        <label className="inline-flex items-center gap-1 text-[11px]"><input type="checkbox" checked={cfg?.requireClass ?? true} disabled={!admin || busy || !data} onChange={(e) => onChange({ requireClass: e.target.checked })} /> class required</label>
        <label className="inline-flex items-center gap-1 text-[11px]"><input type="checkbox" checked={cfg?.requireKnownVendor ?? true} disabled={!admin || busy || !data} onChange={(e) => onChange({ requireKnownVendor: e.target.checked })} /> known supplier required</label>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {data ? `${data.suppliersOnAutoPost}/${data.suppliers} suppliers on auto-post` : "…"}{cfg?.updatedAt ? ` · changed by ${cfg.updatedBy || "?"} ${fmtWhen(cfg.updatedAt)}` : cfg ? " · never changed (default manual)" : ""}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{MODES.find((m) => m.key === mode)?.hint}{data && !data.posting && mode !== "manual" ? " QuickBooks posting is off, so nothing posts until it is switched on in Setup." : ""}</p>
    </div>
  );
}

// ------------------------------------------------------------- decisions
const rate = (v: number | null | undefined) => (v == null ? "—" : pct(v));
const Tick = ({ ok, title }: { ok: boolean; title: string }) => <span title={title} className={cn("inline-block w-4 text-center", ok ? "text-emerald-600" : "text-amber-600")}>{ok ? "✓" : "✗"}</span>;
const ACTION_TONE: Record<string, string> = { post: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", hold: "bg-muted text-muted-foreground", reject: "bg-red-500/15 text-red-600", reprocess: "bg-muted text-muted-foreground", edit_posted: "bg-sky-500/15 text-sky-700 dark:text-sky-400", promote: "bg-violet-500/15 text-violet-700 dark:text-violet-400", demote: "bg-amber-500/15 text-amber-700 dark:text-amber-400" };

function DecisionsTab({ vendor, setVendor }: { vendor: string; setVendor: (v: string) => void }) {
  const { data, loading, error } = useApi<DecisionsResponse>(`/api/finance/intake/decisions?limit=300${vendor ? `&vendor=${encodeURIComponent(vendor)}` : ""}`);
  const s = data?.stats;
  const vendors = React.useMemo(() => Array.from(new Set((data?.stats.vendors || []).map((v) => v.vendorName || v.vendorId))).sort(), [data]);
  const sel = s && vendor ? s.vendors.find((x) => (x.vendorName || x.vendorId) === vendor) : null;
  return (
    <div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {s ? (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {[
            ["Decisions", String(s.overall.decisions)], ["Posted", `${s.overall.posted}${s.overall.autoPosted ? ` (${s.overall.autoPosted} auto)` : ""}`], ["Held / rejected", `${s.overall.held} / ${s.overall.rejected}`],
            ["Class agreement", rate(s.overall.classAgreement)], ["Account agreement", rate(s.overall.accountAgreement)], ["VAT agreement", rate(s.overall.vatAgreement)],
            ["On auto-post", `${s.suppliersOnAutoPost}/${s.suppliers} · ${s.autopilot.mode}`],
          ].map(([k, v]) => <div key={k} className="rounded-lg border border-border/60 p-2"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</p><p className="text-sm font-semibold tabular-nums">{v}</p></div>)}
        </div>
      ) : null}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <select value={vendor} onChange={(e) => setVendor(e.target.value)} className="h-7 rounded border border-border/60 bg-background px-1.5 text-xs"><option value="">All suppliers</option>{vendors.map((v) => <option key={v} value={v}>{v}</option>)}</select>
        {sel ? <span className="text-[11px] text-muted-foreground">{sel.posted} posted · class {rate(sel.classAgreement)} · account {rate(sel.accountAgreement)} · VAT {rate(sel.vatAgreement)} · avg conf {sel.avgConfidence ?? "—"}{sel.autoPost ? " · on auto-post" : ""}</span> : null}
        {loading ? <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" /> : null}
      </div>
      {data && data.decisions.length === 0 && !loading ? <Empty icon={History}>No decisions yet. Every Post, Hold, Reject, Reprocess, edit and auto-post lands here.</Empty> : null}
      {data && data.decisions.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-xs">
            <thead className={THEAD}><tr><TH>When</TH><TH>Who</TH><TH>Supplier</TH><TH>Document</TH><TH>Class proposed → final</TH><TH>Account proposed → final</TH><TH className="text-center">Agree</TH><TH right>Conf.</TH><TH>Action</TH></tr></thead>
            <tbody>
              {data.decisions.map((d) => (
                <tr key={`${d.sha256}-${d.at}-${d.action}`} className="border-b border-border/40 hover:bg-muted/30">
                  <td className="whitespace-nowrap p-2">{fmtWhen(d.at)}</td>
                  <td className="whitespace-nowrap p-2">{d.autopilot ? <span className="inline-flex items-center gap-1"><Bot className="h-3 w-3" /> autopilot</span> : d.by}{d.dryRun ? <span className="ml-1 text-[10px] text-amber-600">dry-run</span> : null}</td>
                  <td className="p-2 font-medium">{d.vendorName || <span className="text-muted-foreground">unknown</span>}</td>
                  <td className="p-2" title={d.sha256}>{d.docNumber || "—"}<span className="ml-1 text-[10px] text-muted-foreground">{d.evidence.fileName || ""}</span></td>
                  <td className="p-2">{d.changed.class ? <><span className="text-muted-foreground line-through">{d.proposed.className || "none"}</span> → <span className="font-medium">{d.final.className || "none"}</span></> : d.final.className || <span className="text-muted-foreground">none</span>}{d.evidence.invoiceTextTokens.length > 0 ? <span className="ml-1 text-[10px] text-muted-foreground" title="tokens learned">· {d.evidence.invoiceTextTokens.join(", ")}</span> : null}</td>
                  <td className="max-w-[220px] truncate p-2" title={`${d.proposed.accounts.join(", ")} → ${d.final.accounts.join(", ")}`}>{d.changed.account ? <><span className="text-muted-foreground line-through">{Array.from(new Set(d.proposed.accounts)).join(", ") || "—"}</span> → <span className="font-medium">{Array.from(new Set(d.final.accounts)).join(", ") || "—"}</span></> : Array.from(new Set(d.final.accounts)).join(", ") || "—"}</td>
                  <td className="whitespace-nowrap p-2 text-center"><Tick ok={!d.changed.vendor} title="vendor" /><Tick ok={!d.changed.class} title="class" /><Tick ok={!d.changed.account} title="account" /><Tick ok={!d.changed.vat} title="VAT" /></td>
                  <td className="p-2 text-right tabular-nums">{pct(d.confidence || 0)}</td>
                  <td className="p-2"><Badge className={cn("border-0 text-[10px] uppercase tracking-wide", ACTION_TONE[d.action] || "bg-muted")}>{d.action.replace("_", " ")}</Badge>{d.note ? <span className="ml-1 text-[10px] text-muted-foreground" title={d.note}>{d.note.slice(0, 60)}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------- edit posted bill
function PostedEditor({ item, options, draft, setDraft, onSave, busy, posting }: { item: IntakeRecord; options: IntakeOptions | null; draft: PostedEditDraft; setDraft: (d: PostedEditDraft) => void; onSave: () => void; busy: boolean; posting: boolean }) {
  const { money2 } = useMoney();
  const r = item.resolution!;
  const setLine = (i: number, patch: Record<string, unknown>) => setDraft({ ...draft, lines: { ...draft.lines, [i]: { ...(draft.lines[i] || {}), ...patch } } });
  const dirty = Object.values(draft.lines).some((l) => Object.keys(l).length) || draft.dueDate !== undefined || draft.docNumber !== undefined || draft.privateNote !== undefined;
  return (
    <details className="mt-2 rounded border border-sky-500/40 bg-sky-500/5 p-2 text-xs">
      <summary className="inline-flex cursor-pointer items-center gap-1 font-medium"><Pencil className="h-3 w-3" /> Edit in QuickBooks <span className="font-normal text-muted-foreground">— bill {item.qbo.billId}{item.qbo.lastEditedAt ? ` · last edited ${fmtWhen(item.qbo.lastEditedAt)}` : ""}</span></summary>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <label className="space-y-1"><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Due date</span><input type="date" className={select} value={draft.dueDate ?? r.dueDate ?? ""} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} /></label>
        <label className="space-y-1"><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Doc no.</span><input className={select} maxLength={21} value={draft.docNumber ?? r.docNumber ?? ""} onChange={(e) => setDraft({ ...draft, docNumber: e.target.value })} /></label>
        <label className="space-y-1"><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Memo (private note)</span><input className={select} value={draft.privateNote ?? ""} placeholder="leave blank to keep" onChange={(e) => setDraft({ ...draft, privateNote: e.target.value })} /></label>
      </div>
      <div className="overflow-x-auto">
        <table className="mt-2 w-full min-w-[560px] text-xs">
          <thead className="text-muted-foreground"><tr><th className="p-1 text-left font-medium">Line</th><th className="p-1 text-right font-medium">Net</th><th className="w-44 p-1 text-left font-medium">Account</th><th className="w-40 p-1 text-left font-medium">Class</th><th className="w-32 p-1 text-left font-medium">VAT code</th></tr></thead>
          <tbody>
            {r.lines.map((l, i) => {
              const d = draft.lines[i] || {};
              return (
                <tr key={i} className="border-t border-border/30">
                  <td className="max-w-[320px] truncate p-1" title={l.description}>{l.description || "—"}</td>
                  <td className="p-1 text-right tabular-nums">{money2(l.amount)}</td>
                  <td className="p-1">{options ? <select className={select} value={d.accountId ?? l.accountId ?? ""} onChange={(e) => setLine(i, { accountId: e.target.value || null })}><option value="">— keep</option>{options.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select> : l.accountName || "—"}</td>
                  <td className="p-1">{options ? <select className={select} value={d.classId !== undefined ? (d.classId ?? "") : (l.classId ?? "")} onChange={(e) => setLine(i, { classId: e.target.value || null })}><option value="">— none</option>{options.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select> : l.className || "—"}</td>
                  <td className="p-1">{options ? <select className={select} value={d.taxCodeId ?? l.taxCodeId ?? ""} onChange={(e) => setLine(i, { taxCodeId: e.target.value || null })}><option value="">— keep</option>{options.taxCodes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select> : l.vatKind || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-7 gap-1 text-xs" disabled={busy || !dirty} onClick={onSave}><Save className="h-3 w-3" /> {posting ? "Save to QuickBooks" : "Save (dry-run)"}</Button>
        <span className="text-[11px] text-muted-foreground">Full Bill update in QuickBooks; the change is logged as a decision and a class change teaches the resolver (and takes the supplier off auto-post).</span>
      </div>
    </details>
  );
}

export function SupplierInvoicesQueue({ connected }: { connected: boolean }) {
  const { money2 } = useMoney();
  const { user } = useCompany();
  const admin = user?.role === "admin";
  const [state, setState] = React.useState<StateKey>("open");
  const [vendorFilter, setVendorFilter] = React.useState("");
  const [decisionVendor, setDecisionVendor] = React.useState("");
  const listUrl = `/api/finance/intake?state=${state === "decisions" ? "open" : state}${vendorFilter ? `&vendor=${encodeURIComponent(vendorFilter)}` : ""}`;
  const { data, error: loadError, loading, reload } = useApi<IntakeListResponse>(listUrl);
  const { data: autopilot, setData: setAutopilot } = useApi<AutopilotResponse>("/api/finance/intake/autopilot");
  const [autopilotBusy, setAutopilotBusy] = React.useState(false);
  const [options, setOptions] = React.useState<IntakeOptions | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const [lastRun, setLastRun] = React.useState<IntakeRunSummary | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [edits, setEdits] = React.useState<Record<string, ResolveOverrides>>({});
  const [postedEdits, setPostedEdits] = React.useState<Record<string, PostedEditDraft>>({});

  const changeAutopilot = async (patch: Partial<AutopilotConfig>) => {
    if (!admin) return;
    if (patch.mode && patch.mode !== "manual" && !window.confirm(`Switch autopilot to ${patch.mode}? ${MODES.find((m) => m.key === patch.mode)?.hint || ""}`)) return;
    setAutopilotBusy(true); setError(null);
    try { setAutopilot(await api<AutopilotResponse>("/api/finance/intake/autopilot", { method: "PUT", json: patch })); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setAutopilotBusy(false); }
  };
  const loadOptions = React.useCallback(async (fresh = false) => {
    if (options && !fresh) return;
    try { setOptions(await api<IntakeOptions>(`/api/finance/intake?options=1${fresh ? "&fresh=1" : ""}`)); } catch { /* selects fall back to text */ }
  }, [options]);
  // Refresh = the queue AND the QuickBooks vendor/account/class lists, so a
  // category created in QuickBooks a moment ago is selectable straight away.
  const refreshAll = async () => { await Promise.all([reload(), loadOptions(true)]); };
  const toggle = (sha: string) => { const next = open === sha ? null : sha; setOpen(next); if (next) loadOptions(); };

  const act = async (sha: string, action: "post" | "hold" | "reject" | "reprocess", extra: Record<string, unknown> = {}) => {
    setBusy(sha + action); setError(null);
    try { await api(`/api/finance/intake/${sha}`, { method: "POST", json: { action, ...extra } }); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setBusy(null); }
  };
  const saveEdit = async (sha: string) => {
    const d = postedEdits[sha]; if (!d) return;
    const changes: PostedEdit = {
      lines: Object.entries(d.lines).map(([i, l]) => ({ index: Number(i), ...l })).filter((l) => l.accountId !== undefined || l.classId !== undefined || l.taxCodeId !== undefined),
      ...(d.dueDate !== undefined ? { dueDate: d.dueDate } : {}), ...(d.docNumber !== undefined ? { docNumber: d.docNumber } : {}), ...(d.privateNote !== undefined && d.privateNote !== "" ? { privateNote: d.privateNote } : {}),
    };
    setBusy(sha + "edit"); setError(null);
    try {
      await api(`/api/finance/intake/${sha}`, { method: "POST", json: { action: "edit_posted", changes } });
      setPostedEdits((e) => { const n = { ...e }; delete n[sha]; return n; });
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setBusy(null); }
  };
  const runNow = async () => {
    setRunning(true); setError(null);
    try { setLastRun(await api<IntakeRunSummary>("/api/finance/intake", { method: "POST", json: { action: "run" } })); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setRunning(false); }
  };
  const edit = (sha: string, patch: (o: ResolveOverrides) => ResolveOverrides) => setEdits((e) => ({ ...e, [sha]: patch(e[sha] || {}) }));
  const editLine = (sha: string, i: number, patch: Record<string, unknown>) => edit(sha, (o) => { const lines = [...(o.lines || [])]; lines[i] = { ...(lines[i] || {}), ...patch }; return { ...o, lines }; });

  const counts = data?.counts || {};
  const openCount = (counts.proposed || 0) + (counts.held || 0);

  return (
    <Section id="supplier-invoices" icon={Inbox} title="Supplier invoices — intake queue" hint={data ? `${openCount} to review · ${counts.posted || 0} posted · mailboxes ${data.mailboxes.filter((m) => m.ok).length}/${data.mailboxes.length} reachable` : "PDF invoices found in the intake mailboxes, coded for QuickBooks"}
      actions={<>
        <input value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} placeholder="Supplier…" aria-label="Filter by supplier" className="h-7 w-32 rounded border border-border/60 bg-background px-2 text-xs" />
        <RefreshButton onClick={refreshAll} loading={loading} title="Reload the queue and re-read QuickBooks vendors, categories and classes" />
        <Button size="sm" className="h-7 gap-1 text-xs" onClick={runNow} disabled={running}><Play className={cn("h-3 w-3", running && "animate-pulse")} /> {running ? "Scanning…" : "Run intake now"}</Button>
      </>}>
      {data && !data.posting ? (
        <Notice tone="warn"><span className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span><strong>Dry run.</strong> QuickBooks posting is off: &ldquo;Post&rdquo; records the exact QuickBooks payload on the item and creates nothing. Nothing is auto-posted. Switch it on in Setup ▸ QuickBooks when the coding looks right.{!data.intakeEnabled ? " The scheduled scan is also off; use “Run intake now”." : ""}</span></span></Notice>
      ) : null}
      <AutopilotControl data={autopilot} admin={!!admin} busy={autopilotBusy} onChange={changeAutopilot} />
      <div className="mb-3 flex flex-wrap items-center gap-1">
        {STATES.map((s) => (
          <button key={s.key} type="button" onClick={() => setState(s.key)} className={cn("h-7 rounded-full border px-2.5 text-xs transition-colors", state === s.key ? "border-foreground bg-foreground text-background" : "border-border/60 hover:bg-muted/40")}>
            {s.label}{s.key === "open" ? (openCount ? ` ${openCount}` : "") : counts[s.key] ? ` ${counts[s.key]}` : ""}
          </button>
        ))}
        <button type="button" onClick={() => setState("decisions")} className={cn("inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors", state === "decisions" ? "border-foreground bg-foreground text-background" : "border-border/60 hover:bg-muted/40")}><History className="h-3 w-3" /> Decisions</button>
      </div>

      {data ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {data.mailboxes.map((m) => (
            <span key={m.mailbox} title={m.error || (m.watermark ? `scanned to ${fmtWhen(m.watermark)}` : "not scanned yet")} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", m.ok === true ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400" : m.ok === false ? "border-red-500/40 text-red-600" : "border-border/60 text-muted-foreground")}>
              <Inbox className="h-3 w-3" /> {m.mailbox}{m.ok === false ? " · unreachable" : m.watermark ? ` · ${fmtWhen(m.watermark)}` : ""}
            </span>
          ))}
          {data.mailboxes.length === 0 ? <span className="text-[11px] text-muted-foreground">No intake mailboxes configured — add them in Setup ▸ Mailboxes.</span> : null}
        </div>
      ) : null}
      {lastRun ? (
        <p className="mb-2 text-[11px] text-muted-foreground">
          Last run: {lastRun.skipped ? lastRun.skipped : `${lastRun.scanned} messages · ${lastRun.pdfs} PDFs · ${lastRun.created} new · ${lastRun.proposed} proposed · ${lastRun.posted} posted · ${lastRun.held} held · ${lastRun.duplicate} duplicate · ${lastRun.notInvoice} not invoices · ${Math.round(lastRun.ms / 100) / 10}s`}
          {lastRun.errors?.length ? ` · ${lastRun.errors.length} errors: ${lastRun.errors.slice(0, 2).join("; ")}` : ""}
        </p>
      ) : null}
      {error || loadError ? <ErrorNote>{error || loadError}</ErrorNote> : null}
      {!connected ? <p className="mb-2 text-xs text-amber-600">QuickBooks is not connected: invoices are still collected and extracted, but vendor / account / class resolution and posting need the connection.</p> : null}

      {state === "decisions" ? <DecisionsTab vendor={decisionVendor} setVendor={setDecisionVendor} /> : null}
      {state !== "decisions" && data && data.items.length === 0 && !loading ? <Empty>Nothing here.</Empty> : null}
      {state !== "decisions" && data && data.items.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-xs">
            <thead className={THEAD}><tr><TH>Received</TH><TH>Mailbox</TH><TH>Supplier</TH><TH>Doc no.</TH><TH>Date</TH><TH>Due</TH><TH right>Gross</TH><TH>Class</TH><TH>Account</TH><TH right>Conf.</TH><TH>Reasons</TH><TH /></tr></thead>
            <tbody>
              {data.items.map((it) => {
                const r = it.resolution; const a = it.arrivals[0]; const ov = edits[it.sha256] || {};
                const accounts = Array.from(new Set((r?.lines || []).map((l) => l.accountName).filter(Boolean)));
                const isOpen = open === it.sha256;
                const canAct = !["posted", "rejected"].includes(it.state);
                return (
                  <React.Fragment key={it.sha256}>
                    <tr className={cn("cursor-pointer border-b border-border/40 hover:bg-muted/30", it.state === "posted" && "text-muted-foreground")} onClick={() => toggle(it.sha256)}>
                      <td className="whitespace-nowrap p-2">{fmtWhen(a?.receivedAt)}</td>
                      <td className="p-2">{short(a?.mailbox || "")}{it.arrivals.length > 1 ? <span className="text-muted-foreground"> +{it.arrivals.length - 1}</span> : null}</td>
                      <td className="p-2 font-medium">{r?.vendorName || it.extraction?.supplierIdentity || <span className="text-muted-foreground">unknown</span>}{r ? <span className={cn("ml-1 text-[10px]", r.vendorScore >= 0.8 ? "text-emerald-600" : "text-red-500")}>{r.vendorId ? pct(r.vendorScore) : "new?"}</span> : null}</td>
                      <td className="p-2">{r?.docNumber || it.extraction?.documentNumber || "—"}</td>
                      <td className="whitespace-nowrap p-2" title={r?.dateNote || undefined}>{fmtDay(r?.txnDate)}{r?.dateNote ? <AlertTriangle className="ml-1 inline h-3 w-3 text-amber-600" /> : null}</td>
                      <td className="whitespace-nowrap p-2" title={r?.termName || undefined}>{fmtDay(r?.dueDate)}</td>
                      <td className="p-2 text-right font-medium tabular-nums">{r ? money2(r.totals.gross) : "—"}</td>
                      <td className="p-2">{r?.className || (r?.classCandidates.length ? <span className="text-amber-600">{r.classCandidates.length} candidates</span> : <span className="text-muted-foreground">—</span>)}</td>
                      <td className="max-w-[160px] truncate p-2" title={accounts.join(", ")}>{accounts.join(", ") || "—"}</td>
                      <td className="p-2 text-right"><Confidence v={it.confidence} reasons={it.reasons} /></td>
                      <td className="max-w-[220px] p-2"><div className="flex flex-wrap gap-1"><StateBadge state={it.state} />{it.reasons.slice(0, 3).map((x) => <span key={x} className="max-w-[180px] truncate rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground" title={x}>{x}</span>)}{it.reasons.length > 3 ? <span className="text-[10px] text-muted-foreground">+{it.reasons.length - 3}</span> : null}</div></td>
                      <td className="p-2 text-right">{isOpen ? <ChevronUp className="inline h-4 w-4" /> : <ChevronDown className="inline h-4 w-4" />}</td>
                    </tr>
                    {isOpen ? (
                      <tr className="border-b border-border/40 bg-muted/10"><td colSpan={12} className="p-3">
                        <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
                          <div className="min-w-0">
                            <div className="mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                              <label className="space-y-1"><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Vendor</span>
                                {options ? <select className={select} value={ov.vendorId ?? r?.vendorId ?? ""} onChange={(e) => edit(it.sha256, (o) => ({ ...o, vendorId: e.target.value || null }))}><option value="">— {r?.vendorProposed ? `create “${r.vendorProposed.displayName}”` : "none"}</option>{options.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select> : <p className="h-7 leading-7">{r?.vendorName || "—"}</p>}
                              </label>
                              <label className="space-y-1"><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Class (project)</span>
                                {options ? <select className={select} value={ov.classId ?? r?.classId ?? ""} onChange={(e) => edit(it.sha256, (o) => ({ ...o, classId: e.target.value || null, allowNoClass: !e.target.value }))}><option value="">— no class (overhead)</option>{(r?.classCandidates || []).map((c) => <option key={"c" + c.classId} value={c.classId}>★ {c.className} ({c.source})</option>)}{options.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select> : <p className="h-7 leading-7">{r?.className || "—"}</p>}
                              </label>
                              <label className="space-y-1"><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Doc no.</span><input className={select} value={ov.docNumber ?? r?.docNumber ?? ""} onChange={(e) => edit(it.sha256, (o) => ({ ...o, docNumber: e.target.value }))} /></label>
                              <div className="grid grid-cols-2 gap-1">
                                <label className="space-y-1"><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Date</span><input type="date" className={select} value={ov.txnDate ?? r?.txnDate ?? ""} onChange={(e) => edit(it.sha256, (o) => ({ ...o, txnDate: e.target.value || null }))} /></label>
                                <label className="space-y-1"><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Due</span><input type="date" className={select} value={ov.dueDate ?? r?.dueDate ?? ""} onChange={(e) => edit(it.sha256, (o) => ({ ...o, dueDate: e.target.value || null }))} /></label>
                              </div>
                            </div>
                            <div className="overflow-x-auto">
                              <table className="w-full min-w-[600px] text-xs">
                                <thead className="text-muted-foreground"><tr><th className="p-1 text-left font-medium">Line</th><th className="p-1 text-right font-medium">Net</th><th className="p-1 text-right font-medium">VAT</th><th className="w-44 p-1 text-left font-medium">Account</th><th className="w-40 p-1 text-left font-medium">Class</th><th className="w-32 p-1 text-left font-medium">VAT code</th></tr></thead>
                                <tbody>
                                  {(r?.lines || []).map((l, i) => {
                                    const lo = ov.lines?.[i] || {};
                                    return (
                                      <tr key={i} className="border-t border-border/30">
                                        <td className="max-w-[320px] truncate p-1" title={l.description}>{l.description || "—"}<span className="ml-1 text-[10px] text-muted-foreground">{l.accountSource}</span></td>
                                        <td className="p-1 text-right tabular-nums">{money2(l.amount)}</td>
                                        <td className="p-1 text-right tabular-nums text-muted-foreground">{money2(l.vat)}</td>
                                        <td className="p-1">{options ? <select className={cn(select, !(lo.accountId || l.accountId) && "border-red-500/60")} value={lo.accountId ?? l.accountId ?? ""} onChange={(e) => editLine(it.sha256, i, { accountId: e.target.value || null })}><option value="">— {l.accountName ? `${l.accountName} (not in QuickBooks)` : "choose"}</option>{options.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select> : <span className={cn(!l.accountId && "text-red-500")}>{l.accountName || "—"}</span>}</td>
                                        <td className="p-1">{options ? <select className={select} value={lo.classId !== undefined ? (lo.classId ?? "") : (ov.classId ?? l.classId ?? "")} onChange={(e) => editLine(it.sha256, i, { classId: e.target.value || null })}><option value="">— inherit / none</option>{options.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select> : <span>{l.className || "—"}</span>}</td>
                                        <td className="p-1">{options ? <select className={cn(select, !(lo.taxCodeId || l.taxCodeId) && "border-red-500/60")} value={lo.taxCodeId ?? l.taxCodeId ?? ""} onChange={(e) => editLine(it.sha256, i, { taxCodeId: e.target.value || null })}><option value="">— choose</option>{options.taxCodes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select> : <span className={cn(!l.taxCodeId && "text-red-500")}>{l.vatKind || "—"}</span>}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                                {r ? <tfoot><tr className="border-t border-border/60 font-medium"><td className="p-1 text-right">Lines {money2(r.totals.linesNet)} · Net {money2(r.totals.net)}</td><td className="p-1 text-right tabular-nums">{money2(r.totals.net)}</td><td className="p-1 text-right tabular-nums">{money2(r.totals.vat)}</td><td className="p-1" colSpan={3}>Gross {money2(r.totals.gross)}{Math.abs(r.totals.linesNet - r.totals.net) > 0.02 ? <span className="ml-2 text-red-500">lines ≠ net</span> : null}</td></tr></tfoot> : null}
                              </table>
                            </div>
                            {it.reasons.length > 0 ? <p className="mt-2 text-[11px] text-muted-foreground"><span className="font-medium">Reasons:</span> {it.reasons.join(" · ")}</p> : null}
                            {r?.matchedPo ? <p className="mt-1 text-[11px] text-muted-foreground">Purchase order {r.matchedPo.reference} · {r.matchedPo.projectName} · {r.matchedPo.orderType}</p> : null}
                            {it.ownerApproval ? <p className="mt-1 text-[11px] text-muted-foreground">New supplier approval: {it.ownerApproval.status}{it.ownerApproval.decidedBy ? ` by ${it.ownerApproval.decidedBy}` : ""} · ref {it.ownerApproval.ref}</p> : null}
                            {it.qbo.dryRun != null ? <details className="mt-2 text-[11px]"><summary className="cursor-pointer text-muted-foreground">Dry-run payload (what QuickBooks would receive)</summary><pre className="mt-1 max-h-64 overflow-auto rounded bg-muted/40 p-2 text-[10px]">{JSON.stringify(it.qbo.dryRun, null, 2)}</pre></details> : null}
                            {it.state === "posted" && it.qbo.billId && r && admin ? (
                              <PostedEditor item={it} options={options} draft={postedEdits[it.sha256] || { lines: {} }} setDraft={(d) => setPostedEdits((e) => ({ ...e, [it.sha256]: d }))} onSave={() => saveEdit(it.sha256)} busy={busy === it.sha256 + "edit"} posting={!!data.posting} />
                            ) : null}
                            {it.qbo.lastEditDryRun != null ? <details className="mt-2 text-[11px]"><summary className="cursor-pointer text-muted-foreground">Last edit dry-run payload</summary><pre className="mt-1 max-h-64 overflow-auto rounded bg-muted/40 p-2 text-[10px]">{JSON.stringify(it.qbo.lastEditDryRun, null, 2)}</pre></details> : null}
                          </div>
                          <div className="space-y-2 text-xs">
                            <a href={`/api/finance/intake/${it.sha256}?pdf=1`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded border border-border/60 px-2 py-1.5 hover:bg-muted/40"><FileText className="h-3.5 w-3.5" /> <span className="truncate">{a?.fileName || "invoice.pdf"}</span> <span className="ml-auto text-muted-foreground">{Math.round(it.evidence.size / 1024)} KB</span></a>
                            <div className="space-y-1 rounded border border-border/60 p-2">
                              {it.arrivals.map((x, k) => <p key={k} className="truncate" title={`${x.from || ""} · ${x.subject || ""}`}><span className="font-medium">{short(x.mailbox)}</span> · {fmtWhen(x.receivedAt)}<br /><span className="text-muted-foreground">{x.from || "?"} — {x.subject || "(no subject)"}</span></p>)}
                              {it.extraction ? <p className="text-muted-foreground">Document: {it.extraction.documentType} · {it.extraction.currency} · {it.extraction.invoiceDateText}{it.extractionSource === "vision" ? " · read from page images" : ""}</p> : null}
                              {it.extractionError ? <p className="text-red-500">Extraction failed: {it.extractionError}</p> : null}
                              {it.decidedBy ? <p className="text-muted-foreground">{it.state} by {it.decidedBy} · {fmtWhen(it.decidedAt)}</p> : null}
                              {it.qbo.billId ? <p className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="h-3 w-3" /> QuickBooks bill {it.qbo.billId}{it.qbo.attachableId ? " + PDF" : ""}</p> : null}
                            </div>
                            {canAct ? (
                              <div className="flex flex-wrap gap-1.5">
                                <Button size="sm" className="h-7 gap-1 text-xs" disabled={!!busy} onClick={() => act(it.sha256, "post", { overrides: edits[it.sha256] })}><CheckCircle2 className="h-3 w-3" /> {data.posting ? "Post to QuickBooks" : "Post (dry-run)"}</Button>
                                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={!!busy} onClick={() => { const reason = window.prompt("Hold reason"); if (reason) act(it.sha256, "hold", { reason }); }}><PauseCircle className="h-3 w-3" /> Hold</Button>
                                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs text-red-600" disabled={!!busy} onClick={() => { const reason = window.prompt("Reject reason"); if (reason) act(it.sha256, "reject", { reason }); }}><XCircle className="h-3 w-3" /> Reject</Button>
                                <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={!!busy} onClick={() => act(it.sha256, "reprocess")}><RefreshCw className={cn("h-3 w-3", busy === it.sha256 + "reprocess" && "animate-spin")} /> Reprocess</Button>
                              </div>
                            ) : null}
                            <p className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"><Copy className="h-3 w-3" /> {it.sha256.slice(0, 16)}…</p>
                          </div>
                        </div>
                      </td></tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </Section>
  );
}
