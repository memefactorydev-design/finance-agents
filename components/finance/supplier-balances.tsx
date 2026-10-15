"use client";

import * as React from "react";
import { Building2, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApi, useMoney } from "@/components/use-api";
import { Section, Stat, RefreshButton, ErrorNote, TH, THEAD, Empty } from "./section";
import { fmtDay, fmtTime } from "./money";
import type { VendorBalanceReport } from "./types";

// Supplier side of the cashflow: QuickBooks "Vendor Balance Detail" parsed
// into open bills by vendor and due-date buckets. Read-only.
export function SupplierBalances({ connected }: { connected: boolean }) {
  const { money, money2 } = useMoney();
  const [fresh, setFresh] = React.useState(0);
  const { data: report, error, loading, reload } = useApi<VendorBalanceReport>(connected ? `/api/finance/vendor-balances${fresh ? "?fresh=1" : ""}` : null, [fresh]);
  const [open, setOpen] = React.useState<string | null>(null);
  return (
    <Section id="supplier-balances" icon={Building2} title="Supplier balances — QuickBooks" hint={report ? `Vendor Balance Detail as of ${report.asOf} · ${report.vendors.length} suppliers with open items · refreshed ${fmtTime(report.fetchedAt)}` : "Open supplier bills and credits with due dates, straight from the ledger"}
      actions={<RefreshButton onClick={() => { if (fresh) reload(); else setFresh(1); }} loading={loading} />}>
      <p className="mb-3 text-xs text-muted-foreground">Feeds the cashflow: what is owed to suppliers and when. Unapplied credits are payments or credits not yet matched to a bill in QuickBooks — reconciliation work, not cash. Disputed bills are under review with the supplier and excluded from the buckets. Payment release stays with the owner.</p>
      {!connected ? <ErrorNote>Connect QuickBooks to read supplier balances.</ErrorNote> : null}
      {error ? <ErrorNote>QuickBooks report unavailable: {error}</ErrorNote> : null}
      {report ? (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
            <Stat label="Net payables" value={money(report.totalOpen)} tone="money" />
            <Stat label="Open bills" value={money(report.totalBills)} />
            <Stat label="Unapplied credits" value={money(report.totalUnapplied)} tone="good" />
            <Stat label={report.disputeCutoff ? `Disputed (pre ${fmtDay(report.disputeCutoff)})` : "Disputed"} value={<span className="line-through decoration-muted-foreground/50">{money(report.totalDisputed)}</span>} tone="muted" />
            <Stat label="Overdue bills" value={money(report.buckets.overdue)} tone="bad" />
            <Stat label="Due 7 days" value={money(report.buckets.next7)} />
            <Stat label="8–14 days" value={money(report.buckets.next14)} />
            <Stat label="15–30 days" value={money(report.buckets.next30)} />
            <Stat label="Later / undated" value={money(report.buckets.later + report.buckets.undated)} tone="muted" />
          </div>
          {report.vendors.length === 0 ? <Empty>No open supplier items in QuickBooks.</Empty> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className={THEAD}><tr><TH>Supplier</TH><TH right>Net</TH><TH right>Overdue</TH><TH right>Unapplied</TH><TH right>Disputed</TH><TH>Next due</TH><TH right>Items</TH><TH /></tr></thead>
                <tbody>
                  {report.vendors.slice(0, 40).map((v) => (
                    <React.Fragment key={v.vendor}>
                      <tr className="cursor-pointer border-b border-border/40 hover:bg-muted/30" onClick={() => setOpen(open === v.vendor ? null : v.vendor)}>
                        <td className="p-2 font-medium">{v.vendor}</td>
                        <td className="p-2 text-right tabular-nums">{money2(v.open)}</td>
                        <td className={cn("p-2 text-right tabular-nums", v.overdue > 0 && "font-semibold text-red-500")}>{v.overdue > 0 ? money2(v.overdue) : "—"}</td>
                        <td className="p-2 text-right tabular-nums text-emerald-600">{v.unapplied < 0 ? money2(v.unapplied) : "—"}</td>
                        <td className="p-2 text-right tabular-nums text-muted-foreground">{v.disputed > 0 ? money2(v.disputed) : "—"}</td>
                        <td className="p-2 text-xs">{fmtDay(v.nextDue)}</td>
                        <td className="p-2 text-right text-xs text-muted-foreground">{v.items.length}</td>
                        <td className="p-2 text-right">{open === v.vendor ? <ChevronUp className="inline h-4 w-4" /> : <ChevronDown className="inline h-4 w-4" />}</td>
                      </tr>
                      {open === v.vendor ? (
                        <tr className="border-b border-border/40 bg-muted/10"><td colSpan={8} className="p-2">
                          <table className="w-full text-xs"><thead className="text-muted-foreground"><tr><th className="p-1 text-left font-medium">Date</th><th className="p-1 text-left font-medium">Type</th><th className="p-1 text-left font-medium">No.</th><th className="p-1 text-left font-medium">Due</th><th className="p-1 text-right font-medium">Amount</th><th className="p-1 text-right font-medium">Open</th></tr></thead>
                            <tbody>{v.items.map((i, k) => (<tr key={k} className={cn("border-t border-border/30", i.disputed && "text-muted-foreground line-through decoration-muted-foreground/40")}><td className="p-1">{fmtDay(i.date)}</td><td className="p-1">{i.type}{i.disputed ? " · disputed" : ""}</td><td className="p-1">{i.num || "—"}</td><td className={cn("p-1", i.daysOverdue != null && "text-red-500")}>{fmtDay(i.dueDate)}{i.daysOverdue != null ? ` · ${i.daysOverdue}d overdue` : ""}</td><td className="p-1 text-right tabular-nums">{money2(i.amount)}</td><td className="p-1 text-right font-medium tabular-nums">{money2(i.openBalance)}</td></tr>))}</tbody>
                          </table>
                        </td></tr>
                      ) : null}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {report.vendors.length > 40 ? <p className="mt-2 text-[11px] text-muted-foreground">Showing the 40 largest balances of {report.vendors.length}. Agents can query any vendor with get_supplier_balances.</p> : null}
        </>
      ) : null}
    </Section>
  );
}
