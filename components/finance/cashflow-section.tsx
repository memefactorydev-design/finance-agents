"use client";

import * as React from "react";
import Link from "next/link";
import { Wallet, EyeOff, Eye } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api, useApi, useMoney, useCompany } from "@/components/use-api";
import { Section, Stat, RefreshButton, ErrorNote, TH, THEAD } from "./section";
import { fmtDay, fmtTime } from "./money";
import type { CashflowOutlook, InboundStage } from "./types";

const STAGES: [InboundStage, string][] = [["deposit", "Deposits"], ["survey", "Survey sign-off"], ["delivery_balance", "Delivery balance"], ["installation", "Installation"], ["retention", "Retention"]];

// Cashflow: bank balance + expected client receipts − live supplier bills,
// 13 weeks. The admin can hide retired bank accounts from the cash figure.
export function CashflowSection({ connected }: { connected: boolean }) {
  const { money } = useMoney();
  const { user, defaults } = useCompany();
  const admin = user?.role === "admin";
  const [fresh, setFresh] = React.useState(0);
  const { data: r, error, loading, reload, setData } = useApi<CashflowOutlook>(connected ? `/api/finance/cashflow${fresh ? "?fresh=1" : ""}` : null, [fresh]);
  const [showLines, setShowLines] = React.useState(false);
  const [showHidden, setShowHidden] = React.useState(false);
  const [toggling, setToggling] = React.useState<string | null>(null);
  const toggleAccount = async (id: string, hidden: boolean) => {
    setToggling(id);
    try {
      const d = await api<{ report: CashflowOutlook }>("/api/finance/cashflow", { method: "PATCH", json: { accountId: id, hidden } });
      setData(d.report);
      toast.success(hidden ? "Account hidden from the cash figure" : "Account back in the cash figure");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Update failed"); } finally { setToggling(null); }
  };
  const maxAbs = r ? Math.max(1, ...r.weeks.map((w) => Math.max(Math.abs(w.closing), w.inbound, w.outbound))) : 1;
  const hiddenAccounts = r ? r.bank.accounts.filter((a) => a.hidden) : [];
  return (
    <Section id="cashflow" icon={Wallet} title="Cashflow — 13 weeks" hint={r ? `Bank balance + expected client receipts − live supplier bills · as of ${r.asOf} · refreshed ${fmtTime(r.fetchedAt)}` : "Bank balance + expected client receipts − live supplier bills"}
      actions={<RefreshButton onClick={() => { if (fresh) reload(); else setFresh(1); }} loading={loading} title="Re-read QuickBooks" />}>
      <p className="mb-3 text-xs text-muted-foreground">Receipts come from each project&apos;s payment schedule ({defaults.depositPct}% deposit · {defaults.surveyPct}% survey sign-off · balance before delivery, plus installation and retention lines). Bank figures are the <strong>QuickBooks book balance</strong> per account — the two agree once every bank-feed line has been categorised and posted. Never treat the balance as available-to-pay.</p>
      {!connected ? <ErrorNote>Connect QuickBooks to read bank balances and supplier bills.</ErrorNote> : null}
      {error ? <ErrorNote>Cashflow unavailable: {error}</ErrorNote> : null}
      {r ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
            <div className="rounded-lg bg-muted/40 p-3">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Bank balance <span className="normal-case tracking-normal">(QuickBooks book)</span></p>
              <p className="font-display text-lg font-bold tabular-nums text-money">{money(r.bank.cash)}</p>
              <div className="mt-1 space-y-0.5">
                {r.bank.accounts.filter((a) => !a.hidden && (a.balance !== 0 || admin)).map((a) => (
                  <p key={a.id} className="group flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span className="truncate">{a.name}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      <span className={cn("tabular-nums", a.type === "Credit Card" && a.balance < 0 && "text-red-500")}>{money(a.balance)}</span>
                      {admin ? <button type="button" title="Retired account — hide from the cash figure" aria-label={`Hide ${a.name}`} disabled={toggling === a.id} onClick={() => toggleAccount(a.id, true)} className="text-muted-foreground transition-opacity hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"><EyeOff className="h-3 w-3" /></button> : null}
                    </span>
                  </p>
                ))}
                {hiddenAccounts.length ? (
                  <div className="pt-1">
                    <button type="button" className="text-[10px] text-muted-foreground hover:underline" onClick={() => setShowHidden((v) => !v)}>{showHidden ? "Hide" : "Show"} {hiddenAccounts.length} retired account{hiddenAccounts.length === 1 ? "" : "s"}</button>
                    {showHidden ? hiddenAccounts.map((a) => (
                      <p key={a.id} className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground/70">
                        <span className="truncate line-through">{a.name}</span>
                        <span className="flex shrink-0 items-center gap-1"><span className="tabular-nums">{money(a.balance)}</span>{admin ? <button type="button" title="Put this account back in the cash figure" aria-label={`Show ${a.name}`} disabled={toggling === a.id} onClick={() => toggleAccount(a.id, false)} className="hover:text-foreground"><Eye className="h-3 w-3" /></button> : null}</span>
                      </p>
                    )) : null}
                  </div>
                ) : null}
              </div>
            </div>
            <Stat label="Expected in (next 30 days)" value={money(r.position.in30)} tone="good" sub={`of ${money(r.inbound.total)} outstanding · ${money(r.inbound.buckets.overdue)} overdue`} />
            <Stat label="Supplier bills due (30 days)" value={money(r.position.out30)} tone="bad" sub={`${money(r.outbound.overdue)} already overdue · ${money(r.outbound.underReview)} under review`} />
            <Stat label="Projected position (30 days)" value={money(r.position.projected30)} tone={r.position.projected30 < 0 ? "bad" : "default"} sub={r.position.low ? `low point ${money(r.position.low.closing)} w/c ${fmtDay(r.position.low.week)}` : undefined} />
          </div>

          {r.outbound.suppliers?.some((s) => s.blockRisk) || r.commitments?.items?.length ? (
            <div className="mb-4 flex flex-wrap items-center gap-2 text-[11px]">
              {r.outbound.suppliers.filter((s) => s.blockRisk).map((s) => (
                <span key={s.vendor} className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-red-600">{s.vendor}: {s.onHold ? "on hold" : s.proformaOnly ? "pro-forma only" : `${s.maxDaysOverdue}d overdue, blocks at ${s.blockAfterDaysOverdue}d`}</span>
              ))}
              {r.commitments?.items?.length ? <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">Standing commitments next 90 days {money(r.commitments.total90)} ({r.commitments.items.length} items)</span> : null}
            </div>
          ) : null}
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
            {STAGES.map(([k, l]) => <div key={k} className="rounded-lg border border-border/60 p-2"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{l}</p><p className="text-sm font-semibold tabular-nums">{money(r.inbound.byStage[k])}</p></div>)}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead className={THEAD}><tr><TH>Week</TH><TH right>In</TH><TH right>Out</TH><TH right>Commitments</TH><TH right>Net</TH><TH right>Closing</TH><TH className="w-[40%]">Balance</TH></tr></thead>
              <tbody>
                {r.weeks.map((w, i) => (
                  <tr key={w.start} className="border-b border-border/40">
                    <td className="whitespace-nowrap p-2">{i === 0 ? "This week" : `w/c ${fmtDay(w.start)}`}{i === 0 && (w.inboundLines || w.outboundItems) ? <span className="text-muted-foreground"> · incl. overdue</span> : null}</td>
                    <td className="p-2 text-right tabular-nums text-emerald-600">{w.inbound ? money(w.inbound) : "—"}</td>
                    <td className="p-2 text-right tabular-nums text-red-500">{w.outbound ? money(w.outbound) : "—"}</td>
                    <td className="p-2 text-right tabular-nums text-muted-foreground">{w.commitments ? money(w.commitments) : "—"}</td>
                    <td className={cn("p-2 text-right tabular-nums", w.net < 0 && "text-red-500")}>{money(w.net)}</td>
                    <td className={cn("p-2 text-right font-semibold tabular-nums", w.closing < 0 && "text-red-500")}>{money(w.closing)}</td>
                    <td className="p-2"><div className="relative h-2 overflow-hidden rounded bg-muted/50"><div className={cn("absolute inset-y-0 rounded", w.closing < 0 ? "bg-red-400" : "bg-primary/60")} style={{ left: w.closing < 0 ? `${50 - (Math.abs(w.closing) / maxAbs) * 50}%` : "50%", width: `${(Math.abs(w.closing) / maxAbs) * 50}%` }} /><div className="absolute inset-y-0 left-1/2 w-px bg-border" /></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button type="button" className="mt-3 text-xs text-primary hover:underline" onClick={() => setShowLines((v) => !v)}>{showLines ? "Hide" : "Show"} expected receipts ({r.inbound.lines.length})</button>
          {showLines ? (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <thead className={THEAD}><tr><TH>Due</TH><TH>Client</TH><TH>Line</TH><TH>Status</TH><TH right>Amount</TH></tr></thead>
                <tbody>{r.inbound.lines.map((l, k) => <tr key={k} className="border-b border-border/40"><td className={cn("whitespace-nowrap p-2", l.bucket === "overdue" && "text-red-500")}>{fmtDay(l.dueDate)}</td><td className="p-2"><Link className="hover:underline" href={`/projects/${encodeURIComponent(l.projectId)}`}>{l.client}</Link></td><td className="p-2">{l.label}</td><td className="p-2">{l.status}{l.invoiceNumber ? ` · ${l.invoiceNumber}` : ""}</td><td className="p-2 text-right tabular-nums">{money(l.amount)}</td></tr>)}</tbody>
              </table>
            </div>
          ) : null}
          {r.notes.length ? <ul className="mt-3 space-y-0.5">{r.notes.map((n, i) => <li key={i} className="text-[11px] text-muted-foreground">· {n}</li>)}</ul> : null}
        </>
      ) : null}
    </Section>
  );
}
