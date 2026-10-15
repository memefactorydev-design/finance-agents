"use client";

import * as React from "react";
import { Coins, RotateCcw, Plus, Trash2, FileText, HardHat, Pencil, Package } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card } from "@/components/ui/card";
import type { Invoice, Project, ScheduleKey } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import { api, useCompany, useMoney } from "@/components/use-api";
import { MoneyField } from "./money-field";
import { LineStatusChip } from "./status-chip";
import { InvoiceActions } from "./invoice-actions";
import { RaiseInvoiceDialog } from "./raise-invoice-dialog";
import { EditInvoiceDialog } from "./edit-invoice-dialog";
import { DeleteInvoiceDialog } from "./delete-invoice-dialog";
import { RecordPaymentPopover } from "./record-payment-popover";
import { grossFromNet, netFromGross, paymentsTaken, fmtDate } from "./money";
import type { FinanceMutationResult, ProjectSchedule, ResolvedLine } from "./types";

// Order value (net | VAT | gross, plus the separate installation contract)
// and the payment schedule for one project. Every money edit goes through
// POST /api/finance/projects/[id]/finance, which returns the recalculated
// schedule, so the client never does the schedule maths itself.
type Act = (body: Record<string, unknown>, successMsg?: string) => Promise<FinanceMutationResult | null>;

function OrderValueCard({ project, schedule, act }: { project: Project; schedule: ProjectSchedule; act: Act }) {
  const { money, money2 } = useMoney();
  const { defaults } = useCompany();
  const of = project.orderFinance;
  const vat = typeof of?.vatRate === "number" ? of.vatRate : defaults.defaultVatRate;
  const net = project.wonValue || 0;
  const gross = grossFromNet(net, vat);
  const install = of?.installation || null;
  const iVat = typeof install?.vatRate === "number" ? install.vatRate : vat;
  const iGross = grossFromNet(install?.value || 0, iVat);
  const [entry, setEntry] = React.useState<"net" | "gross">("net");
  const setNet = (value: number | null) => act({ action: "set_order_finance", netValue: value ?? 0 }, "Order value updated");
  const setVat = (v: string) => { const rate = parseFloat(v); if (Number.isNaN(rate) || rate < 0 || rate > 100 || rate === vat) return; act({ action: "set_order_finance", vatRate: rate }, `VAT set to ${rate}%`); };
  const setInstall = (patch: { value?: number | null; retentionApplies?: boolean } | null, msg: string) =>
    act({ action: "set_order_finance", installation: patch === null ? null : { value: patch.value !== undefined ? patch.value : install?.value ?? null, retentionApplies: patch.retentionApplies !== undefined ? patch.retentionApplies : !!install?.retentionApplies } }, msg);
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div><h3 className="flex items-center gap-1.5 text-sm font-semibold"><Coins className="h-4 w-4 text-money" /> Order value</h3><p className="text-[11px] text-muted-foreground">The order, excluding installation</p></div>
        <div className="text-right"><p className="text-[10px] uppercase tracking-wide text-muted-foreground">Gross inc VAT</p><p className="font-display text-2xl font-bold leading-tight tabular-nums text-money">{money(gross)}</p></div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Net (ex VAT)</p>
          {entry === "net" ? <MoneyField value={project.wonValue} onCommit={setNet} title="Net order value (ex VAT, excluding installation)" /> : <p className="flex h-9 items-center px-1 text-sm font-medium tabular-nums">{money2(net)}</p>}
        </div>
        <div>
          <p className="mb-1 text-xs text-muted-foreground">VAT rate</p>
          <div className="relative"><Input type="number" min={0} max={100} step={0.5} className="h-9 pr-6 text-sm font-medium" defaultValue={vat} key={vat} onBlur={(e) => setVat(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} aria-label="VAT rate" /><span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span></div>
        </div>
        <div><p className="mb-1 text-xs text-muted-foreground">VAT</p><p className="flex h-9 items-center px-1 text-sm font-medium tabular-nums">{money2(gross - net)}</p></div>
        <div>
          <div className="mb-1 flex items-center justify-between"><p className="text-xs text-muted-foreground">Gross (inc VAT)</p><button type="button" className="text-[10px] text-primary hover:underline" onClick={() => setEntry(entry === "net" ? "gross" : "net")}>{entry === "net" ? "enter gross" : "enter net"}</button></div>
          {entry === "gross" ? <MoneyField value={gross} onCommit={(g) => setNet(g == null ? null : netFromGross(g, vat))} /> : <p className="flex h-9 items-center px-1 text-sm font-semibold tabular-nums text-money">{money2(gross)}</p>}
        </div>
      </div>
      <div className="border-t border-border/60 pt-3">
        {project.supplyOnly ? <p className="flex items-center gap-1 text-[11px] text-muted-foreground"><Package className="h-3 w-3" /> Supply only — no installation contract</p> : install ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[150px] flex-1"><p className="mb-1 flex items-center gap-1 text-xs text-muted-foreground"><HardHat className="h-3 w-3" /> Installation value (net)</p><MoneyField value={install.value} onCommit={(v) => setInstall({ value: v }, "Installation value updated")} /></div>
            <div className="min-w-[110px]"><p className="mb-1 text-xs text-muted-foreground">Inc VAT @ {iVat}%</p><p className="flex h-9 items-center px-1 text-sm font-semibold tabular-nums">{money2(iGross)}</p></div>
            <label className="flex h-9 cursor-pointer select-none items-center gap-2 text-xs" title={`Hold ${defaults.retentionPct}% of the installation value until Stage 2 sign-off`}><Switch checked={!!install.retentionApplies} onCheckedChange={(c) => setInstall({ retentionApplies: c }, c ? `${defaults.retentionPct}% retention applied` : "Retention removed")} /> {defaults.retentionPct}% retention</label>
            <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:text-red-500" title="Remove installation contract" aria-label="Remove installation contract" onClick={() => window.confirm("Remove the installation contract from this project?") && setInstall(null, "Installation removed")}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" className="-ml-2 h-8 gap-1 text-xs" onClick={() => setInstall({ value: null, retentionApplies: false }, "Installation contract added")}><Plus className="h-3.5 w-3.5" /> Add installation contract (separate)</Button>
        )}
      </div>
      {(install || project.wonValue) ? <p className="text-[11px] text-muted-foreground">Total inc VAT incl. installation: <span className="font-medium text-foreground">{money2(schedule.contractGross)}</span> · {money2(schedule.contractNet)} net</p> : null}
    </Card>
  );
}

function LineAmount({ line, act, onEditInvoice }: { line: ResolvedLine; act: Act; onEditInvoice: (inv: Invoice) => void }) {
  const { money2 } = useMoney();
  const locked = !!line.invoice; // invoiced amount comes from the invoice
  const editable = !locked && line.applicable;
  const setAmount = (v: number | null) => act({ action: "set_order_finance", lineOverrides: [v == null ? { key: line.key, reset: true } : { key: line.key, amountGross: v }] }, v == null ? `${line.label} reset to default` : `${line.label} set to ${money2(v)}`);
  return (
    <div className="flex items-center justify-end gap-1">
      {editable ? <MoneyField value={line.amountGross} onCommit={setAmount} size="sm" className="w-28" title="Inc VAT — leave blank to reset to the default split" /> : <span className={cn("text-xs font-semibold tabular-nums", !line.applicable && "text-muted-foreground")}>{line.applicable ? money2(line.amountGross) : "—"}</span>}
      {line.overridden && editable ? <button type="button" className="text-muted-foreground hover:text-foreground" title="Reset to default %" aria-label="Reset to default" onClick={() => setAmount(null)}><RotateCcw className="h-3 w-3" /></button> : null}
      {locked && line.invoice && (line.invoice.status === "draft" || line.invoice.status === "sent") ? <button type="button" className="text-muted-foreground hover:text-foreground" title={`Amount is set by invoice ${line.invoice.number} — edit the invoice`} aria-label="Edit invoice" onClick={() => onEditInvoice(line.invoice!)}><Pencil className="h-3 w-3" /></button> : null}
    </div>
  );
}

export function OrderFinancePanel({ project, schedule, onResult }: { project: Project; schedule: ProjectSchedule; onResult: (r: FinanceMutationResult) => void }) {
  const { money2 } = useMoney();
  const [raiseFor, setRaiseFor] = React.useState<ResolvedLine | null>(null);
  const [editFor, setEditFor] = React.useState<Invoice | null>(null);
  const [deleteFor, setDeleteFor] = React.useState<Invoice | null>(null);
  const payments = project.payments || [];
  const totals = schedule.totals;
  const hasValue = (project.wonValue || 0) > 0;
  const act: Act = async (body, successMsg) => {
    try { const r = await api<FinanceMutationResult>(`/api/finance/projects/${encodeURIComponent(project.id)}/finance`, { method: "POST", json: body }); onResult(r); if (successMsg) toast.success(successMsg); return r; }
    catch (e) { toast.error(e instanceof Error ? e.message : "Update failed"); return null; }
  };
  const rows = (group: "order" | "installation") => schedule.lines.filter((l) => l.group === group && (group === "order" || l.applicable));
  return (
    <div className="space-y-3">
      <OrderValueCard project={project} schedule={schedule} act={act} />
      {!hasValue ? <p className="px-1 text-xs text-muted-foreground">Enter the net order value to build the payment schedule.</p> : (
        <div className="overflow-x-auto rounded-xl border border-border/60">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2 text-left font-medium">Payment</th><th className="px-3 py-2 text-right font-medium">Amount inc VAT</th><th className="px-3 py-2 text-left font-medium">Due</th><th className="px-3 py-2 text-right font-medium">Paid</th><th className="px-3 py-2 text-left font-medium">Status</th><th className="px-3 py-2" /></tr></thead>
            <tbody>
              {(["order", "installation"] as const).map((group) => {
                const groupRows = rows(group);
                if (!groupRows.length) return null;
                return (
                  <React.Fragment key={group}>
                    <tr className="bg-muted/20"><td colSpan={6} className="px-3 py-1.5 text-[11px] font-semibold text-muted-foreground">{group === "order" ? `Order · ${money2(totals.order.totalGross)} inc VAT` : `Installation · ${money2(totals.installation.totalGross)} inc VAT`}</td></tr>
                    {groupRows.map((line) => (
                      <tr key={line.key} className={cn("border-t border-border/40", !line.applicable && "opacity-60")}>
                        <td className="whitespace-nowrap px-3 py-2"><p className="font-medium leading-tight">{line.label}{line.pct != null && line.applicable ? <span className="ml-1 text-[11px] font-normal text-muted-foreground">{line.pct}%</span> : null}</p><p className="text-[11px] text-muted-foreground">{line.trigger}</p></td>
                        <td className="px-3 py-2 text-right"><LineAmount line={line} act={act} onEditInvoice={setEditFor} /></td>
                        <td className="px-3 py-2">{line.applicable ? <Input type="date" className="h-8 w-[136px] text-xs" value={line.dueDate || ""} aria-label={`${line.label} due date`} title={line.dueSource === "derived" ? `Derived from ${line.dueRule}` : line.dueSource === "manual" ? "Manual date" : "No date yet"} onChange={(e) => act({ action: "set_order_finance", lineOverrides: [{ key: line.key, dueDate: e.target.value || null }] }, "Due date updated")} /> : <span className="text-muted-foreground">—</span>}</td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums">{line.applicable && line.paidGross > 0 ? money2(line.paidGross) : <span className="text-muted-foreground">—</span>}</td>
                        <td className="px-3 py-2"><LineStatusChip status={line.status} /></td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1 whitespace-nowrap">
                            {line.applicable && line.amountGross > 0 ? (line.invoice ? <InvoiceActions projectId={project.id} invoice={line.invoice} compact onEdit={setEditFor} onDelete={setDeleteFor} onChanged={onResult} /> : line.status !== "paid" ? <Button variant={line.key === "deposit" ? "default" : "outline"} size="sm" className="h-7 gap-1 px-2 text-[11px]" onClick={() => setRaiseFor(line)} title={`Raise a numbered invoice for ${money2(line.amountGross)}`}><FileText className="h-3.5 w-3.5" /> Raise invoice</Button> : null) : null}
                            {line.applicable && line.outstandingGross > 0 ? <RecordPaymentPopover projectId={project.id} line={line} onDone={onResult}><Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[11px] text-money"><Coins className="h-3 w-3" /> Record payment</Button></RecordPaymentPopover> : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
            <tfoot className="bg-muted/30 text-xs"><tr><td className="px-3 py-2 font-semibold">Total</td><td className="px-3 py-2 text-right font-semibold tabular-nums">{money2(totals.totalGross)}</td><td className="px-3 py-2 text-muted-foreground">Taken</td><td className="px-3 py-2 text-right font-semibold tabular-nums text-money">{money2(paymentsTaken(payments))}</td><td className="px-3 py-2 text-muted-foreground">Outstanding</td><td className={cn("px-3 py-2 text-right font-semibold tabular-nums", totals.outstandingGross > 0 ? "text-red-500" : "text-green-600")}>{money2(Math.max(0, totals.totalGross - paymentsTaken(payments)))}</td></tr></tfoot>
          </table>
        </div>
      )}
      {totals.overdueGross > 0 ? <p className="px-1 text-[11px] text-red-500">{money2(totals.overdueGross)} overdue{schedule.lines.filter((l) => l.status === "overdue").map((l) => ` · ${l.label} due ${fmtDate(l.dueDate)}`).join("")}</p> : null}
      <RaiseInvoiceDialog open={!!raiseFor} onOpenChange={(o) => !o && setRaiseFor(null)} projectId={project.id} line={raiseFor} onRaised={onResult} />
      <EditInvoiceDialog open={!!editFor} onOpenChange={(o) => !o && setEditFor(null)} projectId={project.id} invoice={editFor} onSaved={onResult} />
      <DeleteInvoiceDialog open={!!deleteFor} onOpenChange={(o) => !o && setDeleteFor(null)} projectId={project.id} invoice={deleteFor} payments={payments} onDeleted={onResult} />
    </div>
  );
}
export type { ScheduleKey };
