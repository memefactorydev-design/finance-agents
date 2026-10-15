"use client";

import * as React from "react";
import { ShieldAlert, Plus, X, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api, useApi, useMoney } from "@/components/use-api";
import { Section, ErrorNote, RefreshButton, Empty, TH, THEAD, field, label } from "./section";
import { fmtDate } from "./money";
import type { Dispute, DisputesResponse } from "./types";

// Dispute register — the single list of supplier bills we are not paying and
// not being chased on, with the reason and evidence. F7 raises and updates;
// F4 / F5 exclude; F0 reports. Resolving restarts the supplier's 30-day clock.
type DisputeStatus = Dispute["status"];
const STATUSES: DisputeStatus[] = ["open", "awaiting_supplier", "credit_expected", "resolved", "withdrawn"];
const statusLabel: Record<DisputeStatus, string> = { open: "Open", awaiting_supplier: "Awaiting supplier", credit_expected: "Credit expected", resolved: "Resolved", withdrawn: "Withdrawn" };
const statusTone: Record<DisputeStatus, string> = { open: "bg-red-500/15 text-red-500", awaiting_supplier: "bg-amber-500/15 text-amber-600", credit_expected: "bg-sky-500/15 text-sky-600", resolved: "bg-emerald-500/15 text-emerald-600", withdrawn: "bg-muted text-muted-foreground" };

type RaiseDraft = { vendor: string; docNumber: string; billId: string; amount: string; project: string; projectId: string; reason: string; raisedAt: string };
const emptyRaise: RaiseDraft = { vendor: "", docNumber: "", billId: "", amount: "", project: "", projectId: "", reason: "", raisedAt: "" };

function RaiseForm({ postingEnabled, onClose, onRaised }: { postingEnabled: boolean; onClose: () => void; onRaised: (d: Dispute, memo: { state: string; detail?: string }) => void }) {
  const { symbol } = useMoney();
  const [d, setD] = React.useState<RaiseDraft>(emptyRaise);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const set = <K extends keyof RaiseDraft>(k: K, v: string) => setD({ ...d, [k]: v });
  const submit = async () => {
    setSaving(true); setError(null);
    try {
      const j = await api<{ dispute: Dispute; qboMemo: { state: string; detail?: string } }>("/api/finance/disputes", { method: "POST", json: { vendor: d.vendor, docNumber: d.docNumber || null, billId: d.billId || null, amount: Number(d.amount), project: d.project || null, projectId: d.projectId || null, reason: d.reason, raisedAt: d.raisedAt || null } });
      onRaised(j.dispute, j.qboMemo);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setSaving(false); }
  };
  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div><p className="text-sm font-semibold">Raise a dispute</p><p className="text-[11px] text-muted-foreground">From now on this bill is excluded from pay runs, chasing and overdue totals until it is resolved or withdrawn. {postingEnabled ? "With a QuickBooks bill id the Bill memo is tagged [DISPUTED …]." : "QuickBooks posting is off, so the Bill memo step is a dry run."}</p></div>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="col-span-2"><p className={label}>Supplier</p><input className={field} value={d.vendor} onChange={(e) => set("vendor", e.target.value)} /></div>
        <div><p className={label}>Invoice number</p><input className={field} value={d.docNumber} onChange={(e) => set("docNumber", e.target.value)} /></div>
        <div><p className={label}>QuickBooks bill id (optional)</p><input className={cn(field, "font-mono")} value={d.billId} onChange={(e) => set("billId", e.target.value)} /></div>
        <div><p className={label}>Amount {symbol} (gross)</p><input className={field} type="number" min={0} step="0.01" value={d.amount} onChange={(e) => set("amount", e.target.value)} /></div>
        <div><p className={label}>Project / client</p><input className={field} value={d.project} onChange={(e) => set("project", e.target.value)} /></div>
        <div><p className={label}>Project id (optional)</p><input className={cn(field, "font-mono")} value={d.projectId} onChange={(e) => set("projectId", e.target.value)} /></div>
        <div><p className={label}>Raised on (blank = today)</p><input className={field} type="date" value={d.raisedAt} onChange={(e) => set("raisedAt", e.target.value)} /></div>
        <div className="col-span-2 md:col-span-4"><p className={label}>Reason (what is wrong, with evidence refs)</p><textarea className={cn(field, "h-20 py-1")} value={d.reason} onChange={(e) => set("reason", e.target.value)} /></div>
      </div>
      {error ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button size="sm" className="h-7 text-xs" onClick={submit} disabled={saving || !d.vendor || !d.amount || d.reason.trim().length < 5}>{saving ? "Raising…" : "Raise dispute"}</Button>
      </div>
    </div>
  );
}

function DisputeRow({ d, onUpdated }: { d: Dispute; onUpdated: (d: Dispute) => void }) {
  const { money2 } = useMoney();
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [outcome, setOutcome] = React.useState(d.outcome || "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const active = ["open", "awaiting_supplier", "credit_expected"].includes(d.status);
  const patch = async (body: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try { const j = await api<{ dispute: Dispute }>(`/api/finance/disputes/${encodeURIComponent(d.id)}`, { method: "PATCH", json: body }); onUpdated(j.dispute); setNote(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setBusy(false); }
  };
  return (
    <>
      <tr className={cn("cursor-pointer border-b border-border/40 hover:bg-muted/30", !active && "text-muted-foreground")} onClick={() => setOpen(!open)}>
        <td className="p-2 font-medium">{d.vendor}{d.vendorId?.startsWith("pending:") ? <span className="ml-1 text-[10px] text-amber-600">pending</span> : null}</td>
        <td className="p-2 font-mono text-[11px]">{d.docNumber || "—"}{d.billId ? <span className="block text-muted-foreground">bill {d.billId}</span> : null}</td>
        <td className="p-2">{d.project || "—"}</td>
        <td className="p-2 text-right font-medium tabular-nums">{money2(d.amount)}</td>
        <td className="p-2"><Badge className={cn("border-0 text-[10px]", statusTone[d.status])}>{statusLabel[d.status]}</Badge></td>
        <td className="whitespace-nowrap p-2">{fmtDate(d.raisedAt)}</td>
        <td className="max-w-[320px] truncate p-2" title={d.reason}>{d.reason}</td>
        <td className="p-2 text-right">{open ? <ChevronUp className="inline h-4 w-4" /> : <ChevronDown className="inline h-4 w-4" />}</td>
      </tr>
      {open ? (
        <tr className="border-b border-border/40 bg-muted/10"><td colSpan={8} className="p-3">
          <div className="grid gap-4 text-xs md:grid-cols-2">
            <div>
              <p className="mb-1 font-medium">Reason</p>
              <p className="whitespace-pre-wrap text-muted-foreground">{d.reason}</p>
              <p className="mt-2 text-[11px] text-muted-foreground">Raised {fmtDate(d.raisedAt)} by {d.raisedBy}{d.resolvedAt ? ` · closed ${fmtDate(d.resolvedAt)}` : ""}{d.clockRestartAt ? ` · 30-day clock restarted ${fmtDate(d.clockRestartAt)}` : ""} · id <span className="font-mono">{d.id}</span></p>
              {d.outcome ? <p className="mt-2"><span className="font-medium">Outcome:</span> {d.outcome}</p> : null}
              <p className="mb-1 mt-3 font-medium">Evidence and notes ({d.evidence.length})</p>
              {d.evidence.length ? <ul className="space-y-1">{d.evidence.map((e, i) => <li key={i} className="text-muted-foreground"><span className="mr-1 text-[10px] uppercase tracking-wide">{e.kind}</span>{e.kind === "note" ? <span>{e.note}</span> : <span className="font-mono">{e.ref}</span>}{e.kind !== "note" && e.note ? <span> — {e.note}</span> : null}{e.kind === "note" ? <span className="ml-1 text-[10px]">{fmtDate(e.ref)}</span> : null}</li>)}</ul> : <p className="text-muted-foreground">None yet.</p>}
            </div>
            <div onClick={(e) => e.stopPropagation()}>
              <p className="mb-1 font-medium">Update</p>
              <div className="mb-2 flex flex-wrap gap-1">
                {STATUSES.filter((s) => s !== d.status).map((s) => <Button key={s} variant="outline" size="sm" className={cn("h-7 text-xs", (s === "resolved" || s === "withdrawn") && "border-emerald-500/40")} disabled={busy} onClick={() => patch({ status: s, ...(outcome.trim() ? { outcome: outcome.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) })}>{s === "resolved" ? "Resolve" : s === "withdrawn" ? "Withdraw" : `Mark ${statusLabel[s].toLowerCase()}`}</Button>)}
              </div>
              <p className={label}>Outcome (credit note number, agreed amount)</p>
              <input className={cn(field, "mb-2")} value={outcome} onChange={(e) => setOutcome(e.target.value)} />
              <p className={label}>Add a note</p>
              <textarea className={cn(field, "h-16 py-1")} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened, who said what, which email" />
              <div className="mt-2 flex justify-end"><Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy || (!note.trim() && outcome.trim() === (d.outcome || ""))} onClick={() => patch({ ...(note.trim() ? { note: note.trim() } : {}), ...(outcome.trim() !== (d.outcome || "") ? { outcome: outcome.trim() } : {}) })}>{busy ? "Saving…" : "Save note"}</Button></div>
              {error ? <p className="mt-1 text-red-500">{error}</p> : null}
              {!active ? <p className="mt-2 text-[11px] text-muted-foreground">Closed disputes can be reopened with &ldquo;Mark open&rdquo; if the supplier comes back.</p> : null}
            </div>
          </div>
        </td></tr>
      ) : null}
    </>
  );
}

export function DisputeRegister({ connected }: { connected: boolean }) {
  const { money2 } = useMoney();
  const [status, setStatus] = React.useState<"active" | "all" | DisputeStatus>("active");
  const { data, error, loading, reload, setData } = useApi<DisputesResponse>(`/api/finance/disputes?status=${status}`);
  const [raising, setRaising] = React.useState(false);
  const rows = data?.disputes || null;
  const total = (rows || []).reduce((s, d) => s + d.amount, 0);
  const onUpdated = (d: Dispute) => setData((cur) => (cur ? { ...cur, disputes: cur.disputes.map((x) => (x.id === d.id ? d : x)) } : cur));
  return (
    <Section id="dispute-register" icon={ShieldAlert} title="Dispute register" hint={<>Supplier bills we are not paying and must not be chased on, with the reason and evidence. Excluded from cash buckets and pay runs; every remittance and supplier email names them. Resolving restarts the supplier&apos;s 30-day clock.{rows ? ` ${rows.length} shown · ${money2(total)}` : ""}{!connected ? " · QuickBooks not connected — the register still works, Bill memos cannot be tagged." : ""}</>}
      actions={<>
        <select className="h-7 rounded-md border border-input bg-background px-2 text-xs" aria-label="Status filter" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="active">Active</option><option value="all">All</option>{STATUSES.map((s) => <option key={s} value={s}>{statusLabel[s]}</option>)}</select>
        <RefreshButton onClick={reload} loading={loading} />
        <Button size="sm" className="h-7 gap-1 text-xs" onClick={() => setRaising(true)}><Plus className="h-3 w-3" /> Raise dispute</Button>
      </>}>
      {error ? <ErrorNote>Register unavailable: {error}</ErrorNote> : null}
      {raising ? <RaiseForm postingEnabled={!!data?.postingEnabled} onClose={() => setRaising(false)} onRaised={(d, memo) => { setRaising(false); toast.success(`Dispute raised for ${d.vendor} ${d.docNumber || ""} (${money2(d.amount)}). QuickBooks memo: ${memo.state}${memo.detail ? ` — ${memo.detail}` : ""}.`); reload(); }} /> : null}
      {rows && rows.length === 0 ? <Empty icon={ShieldAlert}>No {status === "all" ? "" : status === "active" ? "active " : `${statusLabel[status as DisputeStatus].toLowerCase()} `}disputes.</Empty> : null}
      {rows && rows.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[880px] text-xs">
            <thead className={THEAD}><tr><TH>Supplier</TH><TH>Invoice</TH><TH>Project</TH><TH right>Amount</TH><TH>Status</TH><TH>Raised</TH><TH>Reason</TH><TH /></tr></thead>
            <tbody>{rows.map((d) => <DisputeRow key={d.id} d={d} onUpdated={onUpdated} />)}</tbody>
          </table>
        </div>
      ) : null}
    </Section>
  );
}
