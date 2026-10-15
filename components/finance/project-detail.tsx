"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Pencil, FolderSync, Lock, FileText, Coins, Receipt, StickyNote, ShieldCheck, Plus, Trash2, Mail, Phone, MapPin, CalendarDays } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { PAYMENT_CONFIRMATION_LABEL, projectName, type Invoice, type Project } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import { api, useApi, useMoney } from "@/components/use-api";
import { ProjectStatusChip, InvoiceStatusChip } from "./status-chip";
import { ProjectFormDialog } from "./project-form-dialog";
import { OrderFinancePanel } from "./order-finance-panel";
import { SupplierOrdersEditor } from "./supplier-orders-editor";
import { InvoiceActions } from "./invoice-actions";
import { EditInvoiceDialog } from "./edit-invoice-dialog";
import { DeleteInvoiceDialog } from "./delete-invoice-dialog";
import { RaiseInvoiceDialog } from "./raise-invoice-dialog";
import { ExtraCostDialog } from "./extra-cost-dialog";
import { Section, Stat, ErrorNote, Notice, Empty, TH, THEAD } from "./section";
import { invoiceTotal, fmtDate, fmtWhen, SCHEDULE_LABEL, paymentsTaken, personName } from "./money";
import type { FinanceMutationResult, ProjectNote, ProjectResponse, SyncResult } from "./types";

export function ProjectDetail({ id }: { id: string }) {
  const { money, money2 } = useMoney();
  const { data, error, loading, reload, setData } = useApi<ProjectResponse>(`/api/finance/projects/${encodeURIComponent(id)}`);
  const [editing, setEditing] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [raising, setRaising] = React.useState(false);
  const [editFor, setEditFor] = React.useState<Invoice | null>(null);
  const [deleteFor, setDeleteFor] = React.useState<Invoice | null>(null);
  const [extraOpen, setExtraOpen] = React.useState(false);
  const onResult = React.useCallback((r: FinanceMutationResult) => setData({ project: r.project, schedule: r.schedule }), [setData]);
  const onProject = (p: Project) => { setData((d) => (d ? { ...d, project: p } : d)); reload(); };
  const sync = async () => {
    setSyncing(true);
    try { const r = await api<SyncResult>("/api/finance/crm-sync", { method: "POST", json: {} }); toast[r.ok ? "success" : "error"](r.ok ? `Synced ${r.upserted} of ${r.fetched} projects` : `Sync failed: ${r.errors[0] || "unknown"}`); reload(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Sync failed"); } finally { setSyncing(false); }
  };

  if (error) return <div className="space-y-3"><Link href="/projects" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="h-4 w-4" /> Projects</Link><ErrorNote>{error}</ErrorNote></div>;
  if (!data) return <p className="text-sm text-muted-foreground">{loading ? "Loading project…" : "Not found."}</p>;
  const { project: p, schedule } = data;
  const managed = p.source.kind !== "manual";
  const name = projectName(p) || p.id;
  const invoices = [...(p.invoices || [])].sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.number.localeCompare(a.number));
  const payments = [...(p.payments || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const extras = [...(p.extraCosts || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const raisable = schedule.lines.filter((l) => l.applicable && l.amountGross > 0 && !l.invoice && l.status !== "paid");
  const removeExtra = async (xid: string) => {
    if (!window.confirm("Remove this extra cost?")) return;
    try { onResult(await api<FinanceMutationResult>(`/api/finance/projects/${encodeURIComponent(p.id)}/finance`, { method: "POST", json: { action: "remove_extra_cost", id: xid } })); toast.success("Extra cost removed"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Remove failed"); }
  };
  const dates: [string, string | null | undefined][] = [["Won", p.wonDate], ["Survey sign-off", p.surveyOrderAt], ["Delivery", p.deliveryDate], ["Install start", p.installStart], ["Install end", p.installEnd], ["Stage 1 sign-off", p.signOff1At], ["Stage 2 sign-off", p.signOff2At]];

  return (
    <div className="space-y-4">
      <Link href="/projects" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft className="h-4 w-4" /> Projects</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-bold">{name} <ProjectStatusChip status={p.status} /><Badge variant="secondary" className="text-[10px]">{managed ? `${p.source.kind} · CRM` : "manual"}</Badge></h1>
          <p className="text-sm text-muted-foreground">{[p.opsStage, personName(p.designer), p.postcode].filter(Boolean).join(" · ") || p.id}{p.source.syncedAt ? ` · synced ${fmtWhen(p.source.syncedAt)}` : ""}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {managed ? <Button variant="outline" size="sm" className="gap-1.5" onClick={sync} disabled={syncing}><FolderSync className={cn("h-3.5 w-3.5", syncing && "animate-spin")} /> {syncing ? "Syncing…" : "Sync now"}</Button> : <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /> Edit project</Button>}
          <Button size="sm" className="gap-1.5" onClick={() => setRaising(true)} title={raisable.length ? `Raise an invoice for one of ${raisable.length} scheduled payment${raisable.length === 1 ? "" : "s"}` : "Every scheduled payment is invoiced or paid"}><FileText className="h-3.5 w-3.5" /> New invoice</Button>
        </div>
      </div>
      {managed ? <Notice tone="info"><span className="flex items-start gap-2"><Lock className="mt-0.5 h-4 w-4 shrink-0" /><span><strong>Managed by your CRM (read-only).</strong> Contact details, dates and supplier orders come from the connector and are replaced on every sync. Receipts, invoices, extra costs and the order finance overrides are kept here and survive a re-sync.</span></span></Notice> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Contract inc VAT" value={money(schedule.contractGross)} tone="money" sub={`${money(schedule.contractNet)} net`} />
        <Stat label="Taken" value={money(paymentsTaken(p.payments))} tone="good" sub={`${payments.length} payment${payments.length === 1 ? "" : "s"}`} />
        <Stat label="Outstanding" value={money(schedule.totals.outstandingGross)} tone={schedule.totals.overdueGross > 0 ? "bad" : "default"} sub={schedule.totals.overdueGross > 0 ? `${money(schedule.totals.overdueGross)} overdue` : undefined} />
        <Stat label="Invoices" value={String(invoices.filter((i) => i.status !== "void").length)} sub={`${invoices.filter((i) => i.status === "paid").length} paid · ${invoices.filter((i) => i.status === "draft" || i.status === "sent").length} open`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <OrderFinancePanel project={p} schedule={schedule} onResult={onResult} />

          <Section icon={FileText} title="Invoices" hint="Customer invoices raised for schedule lines. No agent ever creates these; the final invoice is human-only.">
            {invoices.length === 0 ? <Empty icon={FileText}>No invoices yet — raise one from the payment schedule or with New invoice.</Empty> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className={THEAD}><tr><TH>Invoice</TH><TH>For</TH><TH>Date</TH><TH>Due</TH><TH right>Inc VAT</TH><TH /></tr></thead>
                  <tbody>
                    {invoices.map((inv) => {
                      const isOpen = inv.status === "draft" || inv.status === "sent";
                      const overdue = isOpen && !!inv.dueDate && inv.dueDate < new Date().toISOString().slice(0, 10);
                      return (
                        <tr key={inv.id} className={cn("border-b border-border/40", inv.status === "void" && "opacity-60")}>
                          <td className="whitespace-nowrap p-2"><div className="flex items-center gap-1.5"><FileText className="h-3.5 w-3.5 text-primary" /><span className="font-medium">{inv.number}</span><InvoiceStatusChip status={inv.status} /></div>{inv.status === "paid" && inv.paidAt ? <p className="pl-5 text-[10px] text-green-600">paid {fmtDate(inv.paidAt)}</p> : null}</td>
                          <td className="p-2 text-xs text-muted-foreground">{inv.scheduleKey ? SCHEDULE_LABEL[inv.scheduleKey] : inv.items[0]?.description || "—"}</td>
                          <td className="whitespace-nowrap p-2 text-xs">{fmtDate(inv.date)}</td>
                          <td className={cn("whitespace-nowrap p-2 text-xs", overdue && "font-medium text-red-500")}>{fmtDate(inv.dueDate)}{overdue ? " · overdue" : ""}</td>
                          <td className="whitespace-nowrap p-2 text-right font-semibold tabular-nums">{money2(invoiceTotal(inv))}</td>
                          <td className="p-2"><div className="flex justify-end"><InvoiceActions projectId={p.id} invoice={inv} compact onEdit={setEditFor} onDelete={setDeleteFor} onChanged={onResult} /></div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section icon={Coins} title="Payments" hint="Receipts recorded against the schedule. Each one carries how it was verified.">
            {payments.length === 0 ? <Empty icon={Coins}>No payments recorded. Use “Record payment” on a schedule line.</Empty> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-xs">
                  <thead className={THEAD}><tr><TH>Date</TH><TH right>Amount</TH><TH>Method</TH><TH>Line</TH><TH>Verified</TH><TH>Note</TH></tr></thead>
                  <tbody>{payments.map((pay) => (
                    <tr key={pay.id} className="border-b border-border/40">
                      <td className="whitespace-nowrap p-2">{fmtDate(pay.date)}</td>
                      <td className="p-2 text-right font-medium tabular-nums text-money">{money2(pay.amount)}</td>
                      <td className="p-2">{pay.method}</td>
                      <td className="p-2">{pay.scheduleKey ? SCHEDULE_LABEL[pay.scheduleKey] : <span className="text-muted-foreground">in order</span>}</td>
                      <td className="p-2">{pay.confirmation ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400" title={`${pay.confirmation.by} · ${fmtWhen(pay.confirmation.at)}${pay.confirmation.ref ? ` · ${pay.confirmation.ref}` : ""}`}><ShieldCheck className="h-3 w-3" /> {PAYMENT_CONFIRMATION_LABEL[pay.confirmation.source]}</span> : <span className="text-amber-600">unconfirmed</span>}</td>
                      <td className="max-w-[220px] truncate p-2 text-muted-foreground" title={pay.note}>{pay.note || "—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Section>

          <Section icon={Receipt} title="Extra costs" hint="Net spend outside supplier orders — counts in the Completion P&L." actions={<Button variant="outline" size="sm" className="h-7 gap-1 text-xs text-orange-600" onClick={() => setExtraOpen(true)}><Plus className="h-3 w-3" /> Extra cost</Button>}>
            {extras.length === 0 ? <Empty icon={Receipt}>No extra costs.</Empty> : (
              <ul className="divide-y divide-border/40 text-xs">
                {extras.map((x) => <li key={x.id} className="flex items-center gap-3 py-2"><span className="w-20 shrink-0 text-muted-foreground">{fmtDate(x.date)}</span><Badge variant="secondary" className="text-[10px]">{x.category}</Badge><span className="min-w-0 flex-1 truncate">{x.description}</span><span className="font-medium tabular-nums">{money2(x.amount)}</span><button type="button" className="text-muted-foreground hover:text-red-500" aria-label="Remove extra cost" onClick={() => removeExtra(x.id)}><Trash2 className="h-3.5 w-3.5" /></button></li>)}
              </ul>
            )}
          </Section>

          <SupplierOrdersEditor project={p} readOnly={managed} onSaved={onProject} />
        </div>

        <div className="space-y-4">
          <Card className="space-y-2 p-4 text-sm">
            <h3 className="text-sm font-semibold">Contact</h3>
            <p className="flex items-center gap-2 text-xs"><Mail className="h-3.5 w-3.5 text-muted-foreground" /> {p.email ? <a className="hover:underline" href={`mailto:${p.email}`}>{p.email}</a> : "—"}</p>
            <p className="flex items-center gap-2 text-xs"><Phone className="h-3.5 w-3.5 text-muted-foreground" /> {p.phone || "—"}</p>
            <p className="flex items-start gap-2 text-xs"><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /> <span>{[p.address, p.postcode].filter(Boolean).join(", ") || "—"}</span></p>
            {p.qbo?.className ? <p className="text-[11px] text-muted-foreground">QuickBooks class: {p.qbo.className}</p> : null}
          </Card>
          <Card className="p-4 text-sm">
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><CalendarDays className="h-4 w-4 text-primary" /> Dates</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">{dates.map(([k, v]) => <React.Fragment key={k}><dt className="text-muted-foreground">{k}</dt><dd className="tabular-nums">{fmtDate(v)}</dd></React.Fragment>)}</dl>
            {p.supplyOnly ? <p className="mt-2 text-[11px] text-muted-foreground">Supply only</p> : null}
          </Card>
          <Notes projectId={p.id} />
          {p.notes ? <Card className="p-4 text-xs"><h3 className="mb-1 text-sm font-semibold">Project notes</h3><p className="whitespace-pre-wrap text-muted-foreground">{p.notes}</p></Card> : null}
        </div>
      </div>

      <ProjectFormDialog open={editing} onOpenChange={setEditing} project={p} onSaved={onProject} />
      <RaiseInvoiceDialog open={raising} onOpenChange={setRaising} projectId={p.id} line={null} lines={raisable} onRaised={onResult} />
      <EditInvoiceDialog open={!!editFor} onOpenChange={(o) => !o && setEditFor(null)} projectId={p.id} invoice={editFor} onSaved={onResult} />
      <DeleteInvoiceDialog open={!!deleteFor} onOpenChange={(o) => !o && setDeleteFor(null)} projectId={p.id} invoice={deleteFor} payments={p.payments} onDeleted={onResult} />
      <ExtraCostDialog open={extraOpen} onOpenChange={setExtraOpen} projectId={p.id} projectName={name} onSaved={onResult} />
    </div>
  );
}

function Notes({ projectId }: { projectId: string }) {
  const { data, reload } = useApi<{ notes: ProjectNote[] }>(`/api/finance/projects/${encodeURIComponent(projectId)}/notes`);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const post = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try { await api(`/api/finance/projects/${encodeURIComponent(projectId)}/notes`, { method: "POST", json: { text: text.trim() } }); setText(""); reload(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Note failed"); } finally { setBusy(false); }
  };
  return (
    <Card className="p-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><StickyNote className="h-4 w-4 text-primary" /> Notes</h3>
      <div className="space-y-2">
        <Textarea className="min-h-[56px] text-xs" placeholder="Add a note (forwarded to the CRM when the connector allows)" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex justify-end"><Button size="sm" className="h-7 text-xs" onClick={post} disabled={busy || !text.trim()}>{busy ? "Saving…" : "Add note"}</Button></div>
      </div>
      <ul className="mt-3 space-y-2 text-xs">
        {(data?.notes || []).slice(0, 20).map((n) => <li key={n.id} className="rounded-md bg-muted/30 p-2"><p className="whitespace-pre-wrap">{n.text}</p><p className="mt-1 text-[10px] text-muted-foreground">{n.by} · {fmtWhen(n.at)}</p></li>)}
        {data && data.notes.length === 0 ? <li className="text-muted-foreground">No notes yet.</li> : null}
      </ul>
    </Card>
  );
}
