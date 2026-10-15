"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, FileText, Inbox, AlertTriangle, CheckCircle2, XCircle, Link2, Play, Copy, PackageCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ACK_DISCREPANCY_LABEL } from "@/lib/crm/types";
import { api, useApi, useMoney } from "@/components/use-api";
import { Section, Notice, ErrorNote, RefreshButton, Empty, Pills, TH, THEAD, select } from "./section";
import { fmtWhen, pct } from "./money";
import type { OrderAckRecord, OrderAckState, OrdersIntakeListResponse, OrdersIntakeRunSummary, OpenOrder } from "./types";

// Order acknowledgements: PDFs and email bodies found in the orders mailboxes
// and the purchase order each one was matched to. Unmatched items are matched
// by hand (pick an open order for that supplier) or rejected. Matching writes
// the acknowledgement onto the order.
type StateKey = OrderAckState | "open" | "all";
const STATES: { key: StateKey; label: string }[] = [
  { key: "open", label: "To match" }, { key: "matched", label: "Matched" }, { key: "duplicate", label: "Duplicates" }, { key: "not_ack", label: "Not acks" }, { key: "rejected", label: "Rejected" }, { key: "all", label: "All" },
];
function StateBadge({ state }: { state: OrderAckState }) {
  const tone: Record<OrderAckState, string> = {
    unmatched: "bg-amber-500/15 text-amber-700 dark:text-amber-400", matched: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    rejected: "bg-red-500/15 text-red-600", duplicate: "bg-muted text-muted-foreground line-through", not_ack: "bg-muted text-muted-foreground",
  };
  return <Badge className={cn("border-0 text-[10px] uppercase tracking-wide", tone[state])}>{state.replace("_", " ")}</Badge>;
}

export function OrderAcksQueue({ connected }: { connected: boolean }) {
  const { money2 } = useMoney();
  const [state, setState] = React.useState<StateKey>("open");
  const { data, error: loadError, loading, reload } = useApi<OrdersIntakeListResponse>(`/api/finance/orders-intake?state=${state}`);
  const [error, setError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const [lastRun, setLastRun] = React.useState<OrdersIntakeRunSummary | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [orders, setOrders] = React.useState<Record<string, OpenOrder[]>>({});
  const [choice, setChoice] = React.useState<Record<string, string>>({});
  const [showAll, setShowAll] = React.useState<Record<string, boolean>>({});

  // Open orders for the Match select: per supplier, "all" when the supplier is unknown.
  const loadOrders = React.useCallback(async (supplierId: string | null) => {
    const k = supplierId || "all";
    if (orders[k]) return;
    try { const d = await api<{ orders: OpenOrder[] }>(`/api/finance/orders-intake?orders=${encodeURIComponent(k)}`); setOrders((o) => ({ ...o, [k]: d.orders || [] })); } catch { /* select stays empty */ }
  }, [orders]);
  const toggle = (it: OrderAckRecord) => { const next = open === it.sha256 ? null : it.sha256; setOpen(next); if (next && it.state !== "matched") loadOrders(it.supplier.id); };
  const act = async (sha: string, action: "match" | "reject", extra: Record<string, unknown>) => {
    setBusy(sha + action); setError(null);
    try { await api("/api/finance/orders-intake", { method: "POST", json: { action, sha256: sha, ...extra } }); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setBusy(null); }
  };
  const runNow = async () => {
    setRunning(true); setError(null);
    try { setLastRun(await api<OrdersIntakeRunSummary>("/api/finance/orders-intake", { method: "POST", json: { action: "run" } })); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed"); } finally { setRunning(false); }
  };

  const counts = data?.counts || {};
  const openCount = counts.unmatched || 0;
  const mb = data?.mailbox;
  const boxes = mb?.mailboxes || (mb ? [mb] : []);

  return (
    <Section id="order-acks" icon={PackageCheck} title="Order acknowledgements" hint={data ? `${openCount} to match · ${counts.matched || 0} matched · ${mb?.ok === false ? "mailbox unreachable" : mb?.watermark ? `scanned to ${fmtWhen(mb.watermark)}` : "not scanned yet"}` : "Supplier order acknowledgements (PDF or email body) found in the orders mailboxes, attached to the matching purchase order"}
      actions={<><RefreshButton onClick={reload} loading={loading} /><Button size="sm" className="h-7 gap-1 text-xs" onClick={runNow} disabled={running}><Play className={cn("h-3 w-3", running && "animate-pulse")} /> {running ? "Scanning…" : "Run now"}</Button></>}>
      {mb && !mb.enabled ? <Notice tone="warn"><span className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>The scheduled scan is off. Use &ldquo;Run now&rdquo; to scan {boxes.map((x) => x.mailbox).join(", ") || "the orders mailboxes"}.</span></span></Notice> : null}
      <div className="mb-3"><Pills value={state} onChange={setState} items={STATES.map((s) => ({ key: s.key, label: `${s.label}${s.key === "open" ? (openCount ? ` ${openCount}` : "") : counts[s.key] ? ` ${counts[s.key]}` : ""}` }))} /></div>
      {boxes.length ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {boxes.map((x) => (
            <span key={x.mailbox} title={x.error || (x.watermark ? `scanned to ${fmtWhen(x.watermark)}` : "not scanned yet")} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", x.ok === true ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400" : x.ok === false ? "border-red-500/40 text-red-600" : "border-border/60 text-muted-foreground")}>
              <Inbox className="h-3 w-3" /> {x.mailbox}{x.ok === false ? " · unreachable" : x.watermark ? ` · ${fmtWhen(x.watermark)}` : ""}
            </span>
          ))}
        </div>
      ) : null}
      {lastRun ? (
        <p className="mb-2 text-[11px] text-muted-foreground">
          Last run: {lastRun.skipped ? lastRun.skipped : `${lastRun.scanned} messages · ${lastRun.pdfs} PDFs · ${lastRun.bodies ?? 0} email bodies · ${lastRun.created} new · ${lastRun.matched} matched · ${lastRun.unmatched} to match · ${lastRun.duplicate} duplicate · ${lastRun.notAck} not acks · ${Math.round(lastRun.ms / 100) / 10}s`}
          {lastRun.errors?.length ? ` · ${lastRun.errors.length} errors: ${lastRun.errors.slice(0, 2).join("; ")}` : ""}
        </p>
      ) : null}
      {error || loadError ? <ErrorNote>{error || loadError}</ErrorNote> : null}
      {!connected ? <p className="mb-2 text-xs text-muted-foreground">QuickBooks is not connected — acknowledgements are still matched to purchase orders; nothing here touches the ledger.</p> : null}

      {data && data.items.length === 0 && !loading ? <Empty>Nothing here.</Empty> : null}
      {data && data.items.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-xs">
            <thead className={THEAD}><tr><TH>Received</TH><TH>Sender</TH><TH>Supplier</TH><TH>Order</TH><TH>Project</TH><TH right>Lines</TH><TH right>Discrep.</TH><TH>State</TH><TH /></tr></thead>
            <tbody>
              {data.items.map((it) => {
                const a = it.arrivals[0]; const isOpen = open === it.sha256;
                const canAct = !["matched", "rejected"].includes(it.state);
                const pool = orders[showAll[it.sha256] || !it.supplier.id ? "all" : it.supplier.id] || [];
                const chosen = choice[it.sha256] ?? (it.order.id || "");
                return (
                  <React.Fragment key={it.sha256}>
                    <tr className={cn("cursor-pointer border-b border-border/40 hover:bg-muted/30", it.state === "matched" && "text-muted-foreground")} onClick={() => toggle(it)}>
                      <td className="whitespace-nowrap p-2">{fmtWhen(a?.receivedAt)}{it.arrivals.length > 1 ? <span className="text-muted-foreground"> +{it.arrivals.length - 1}</span> : null}{it.kind === "body" ? <span className="ml-1 rounded bg-sky-500/10 px-1 py-0.5 text-[10px] text-sky-700 dark:text-sky-400" title="Acknowledgement read from the email body">email</span> : null}</td>
                      <td className="max-w-[180px] truncate p-2" title={`${a?.from || ""} · ${a?.subject || ""}`}>{a?.from || "?"}</td>
                      <td className="p-2 font-medium">{it.supplier.name || <span className="text-muted-foreground">unknown</span>}{it.supplier.id ? <span className={cn("ml-1 text-[10px]", it.supplier.score >= 0.8 ? "text-emerald-600" : "text-amber-600")} title={it.supplier.source}>{pct(it.supplier.score)}</span> : null}</td>
                      <td className="whitespace-nowrap p-2">{it.order.reference ? <span className={cn(!it.order.id && "text-muted-foreground")}>{it.order.reference}</span> : <span className="text-muted-foreground">—</span>}{it.order.id ? <span className={cn("ml-1 text-[10px]", it.order.score >= 0.8 ? "text-emerald-600" : "text-amber-600")} title={it.order.source}>{it.order.source === "manual" ? "manual" : pct(it.order.score)}</span> : null}</td>
                      <td className="max-w-[160px] truncate p-2">{it.order.projectName || "—"}</td>
                      <td className="p-2 text-right tabular-nums">{it.extraction?.lines.length ?? 0}</td>
                      <td className="p-2 text-right tabular-nums">{it.ack ? (it.ack.discrepancies.length ? <span className="font-medium text-amber-600" title={it.ack.supplierCost != null ? `supplier ${money2(it.ack.supplierCost)} vs ordered ${money2(it.ack.orderedCost || 0)}` : undefined}>{it.ack.discrepancies.length}</span> : <CheckCircle2 className="inline h-3.5 w-3.5 text-emerald-600" />) : "—"}</td>
                      <td className="max-w-[220px] p-2"><div className="flex flex-wrap gap-1"><StateBadge state={it.state} />{it.reasons.slice(0, 2).map((x) => <span key={x} className="max-w-[160px] truncate rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground" title={x}>{x}</span>)}{it.reasons.length > 2 ? <span className="text-[10px] text-muted-foreground">+{it.reasons.length - 2}</span> : null}</div></td>
                      <td className="p-2 text-right">{isOpen ? <ChevronUp className="inline h-4 w-4" /> : <ChevronDown className="inline h-4 w-4" />}</td>
                    </tr>
                    {isOpen ? (
                      <tr className="border-b border-border/40 bg-muted/10"><td colSpan={9} className="p-3">
                        <div className="grid gap-3 lg:grid-cols-[1fr_300px]">
                          <div className="min-w-0">
                            {it.extraction && (it.extraction.acknowledgementRef || it.extraction.expectedDate || it.extraction.total != null || it.ack?.supplierCost != null) ? (
                              <p className="mb-2 text-[11px] text-muted-foreground">
                                {it.extraction.acknowledgementRef ? <>Supplier ref <span className="font-medium text-foreground">{it.extraction.acknowledgementRef}</span> · </> : null}
                                {it.extraction.expectedDate ? <>Expected <span className="font-medium text-foreground">{it.extraction.expectedDate}</span> · </> : null}
                                {it.extraction.total != null ? <>Printed net total <span className="font-medium text-foreground">{money2(it.extraction.total)}</span> · </> : null}
                                {it.ack?.supplierCost != null ? <>Supplier cost <span className="font-medium text-foreground">{money2(it.ack.supplierCost)}</span> vs ordered {money2(it.ack.orderedCost || 0)}</> : null}
                              </p>
                            ) : null}
                            {it.extraction?.extras && it.extraction.extras.length > 0 ? <p className="mb-2 text-[11px] text-amber-700 dark:text-amber-400">Extras: {it.extraction.extras.map((x) => `${x.label} ${money2(x.amount)}`).join(" · ")}</p> : null}
                            {it.ack && it.ack.discrepancies.length > 0 ? (
                              <div className="overflow-x-auto"><table className="mb-3 w-full min-w-[520px] text-xs">
                                <thead className="text-muted-foreground"><tr><th className="p-1 text-left font-medium">Pos</th><th className="p-1 text-left font-medium">Code</th><th className="p-1 text-left font-medium">Issue</th><th className="p-1 text-left font-medium">Ordered</th><th className="p-1 text-left font-medium">Acknowledged</th><th className="p-1 text-right font-medium">Δ</th></tr></thead>
                                <tbody>{it.ack.discrepancies.map((d, i) => <tr key={i} className="border-t border-border/30"><td className="p-1 tabular-nums">{d.position || ""}</td><td className="p-1 font-medium">{d.lineCode}</td><td className="p-1">{ACK_DISCREPANCY_LABEL[d.field] || d.field.replace(/_/g, " ")}</td><td className="p-1">{d.ordered}</td><td className="p-1">{d.acknowledged}</td><td className={cn("p-1 text-right tabular-nums", (d.delta || 0) > 0 ? "text-red-600" : (d.delta || 0) < 0 ? "text-emerald-600" : "text-muted-foreground")}>{d.delta != null ? `${d.delta > 0 ? "+" : d.delta < 0 ? "−" : ""}${Math.abs(d.delta).toFixed(2)}` : ""}</td></tr>)}</tbody>
                              </table></div>
                            ) : null}
                            {it.extraction && it.extraction.lines.length > 0 ? (
                              <details className="text-xs" open={!it.ack}>
                                <summary className="cursor-pointer text-muted-foreground">{it.extraction.lines.length} extracted {it.extraction.lines.length === 1 ? "line" : "lines"}</summary>
                                <div className="overflow-x-auto"><table className="mt-1 w-full min-w-[520px] text-xs">
                                  <thead className="text-muted-foreground"><tr><th className="p-1 text-left font-medium">Pos</th><th className="p-1 text-left font-medium">Code</th><th className="p-1 text-left font-medium">Description</th><th className="p-1 text-right font-medium">Qty</th><th className="p-1 text-right font-medium">Unit</th></tr></thead>
                                  <tbody>{it.extraction.lines.slice(0, 60).map((l, i) => <tr key={i} className="border-t border-border/30"><td className="p-1 tabular-nums">{l.position || ""}</td><td className="whitespace-nowrap p-1 font-medium">{l.code || "—"}</td><td className="max-w-[360px] truncate p-1" title={l.description}>{l.description || "—"}</td><td className="p-1 text-right tabular-nums">{l.qty}</td><td className="p-1 text-right tabular-nums">{l.unitCost.toFixed(2)}</td></tr>)}</tbody>
                                </table></div>
                              </details>
                            ) : null}
                            {it.reasons.length > 0 ? <p className="mt-2 text-[11px] text-muted-foreground"><span className="font-medium">Reasons:</span> {it.reasons.join(" · ")}</p> : null}
                          </div>
                          <div className="space-y-2 text-xs">
                            <a href={`/api/finance/orders-intake?pdf=${it.sha256}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded border border-border/60 px-2 py-1.5 hover:bg-muted/40"><FileText className="h-3.5 w-3.5" /> <span className="truncate">{a?.fileName || (it.kind === "body" ? "message.txt" : "acknowledgement.pdf")}</span> <span className="ml-auto text-muted-foreground">{Math.round(it.evidence.size / 1024)} KB</span></a>
                            <div className="space-y-1 rounded border border-border/60 p-2">
                              {it.arrivals.map((x, k) => <p key={k} className="truncate" title={`${x.from || ""} · ${x.subject || ""}`}>{fmtWhen(x.receivedAt)}<br /><span className="text-muted-foreground">{x.from || "?"} — {x.subject || "(no subject)"}</span></p>)}
                              {it.order.id ? <p className="text-muted-foreground">On order <span className="font-medium text-foreground">{it.order.reference}</span> · {it.order.projectName}{it.order.projectId ? <> · <Link className="underline" href={`/projects/${encodeURIComponent(it.order.projectId)}`}>project</Link></> : null}</p> : null}
                              {it.decidedBy ? <p className="text-muted-foreground">{it.state} by {it.decidedBy} · {fmtWhen(it.decidedAt)}</p> : null}
                            </div>
                            {canAct ? (
                              <div className="space-y-1.5">
                                <label className="block space-y-1"><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Purchase order{it.supplier.name ? ` — ${it.supplier.name}` : " — all suppliers"}</span>
                                  <select className={select} value={chosen} onChange={(e) => setChoice((c) => ({ ...c, [it.sha256]: e.target.value }))}>
                                    <option value="">— choose an open order</option>
                                    {pool.map((o) => <option key={o.id} value={o.id}>{o.reference} · {o.projectName}{!it.supplier.id ? ` · ${o.supplierName}` : ""} · {o.status.replace("_", " ")}</option>)}
                                  </select>
                                </label>
                                {it.supplier.id && !showAll[it.sha256] ? <p className="text-[11px] text-muted-foreground">{pool.length ? "" : `No open orders for ${it.supplier.name}. `}<button type="button" className="underline" onClick={() => { setShowAll((x) => ({ ...x, [it.sha256]: true })); loadOrders(null); }}>Show all suppliers</button></p> : null}
                                {(!it.supplier.id || showAll[it.sha256]) && !pool.length ? <p className="text-[11px] text-muted-foreground">No open purchase orders.</p> : null}
                                <div className="flex flex-wrap gap-1.5">
                                  <Button size="sm" className="h-7 gap-1 text-xs" disabled={!!busy || !chosen} onClick={() => act(it.sha256, "match", { orderId: chosen })}><Link2 className="h-3 w-3" /> {busy === it.sha256 + "match" ? "Matching…" : "Match"}</Button>
                                  <Button size="sm" variant="outline" className="h-7 gap-1 text-xs text-red-600" disabled={!!busy} onClick={() => { const reason = window.prompt("Reject reason"); if (reason) act(it.sha256, "reject", { reason }); }}><XCircle className="h-3 w-3" /> Reject</Button>
                                </div>
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
