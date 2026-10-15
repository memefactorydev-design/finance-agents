"use client";

import * as React from "react";
import { Package, Plus, Trash2, Save, ChevronDown, ChevronUp, CheckCircle2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ACK_DISCREPANCY_LABEL, orderedCost, acknowledgedCost, type OrderStatus, type OrderType, type Project, type SupplierOrder } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import { api, useApi, useMoney } from "@/components/use-api";
import { Section, Empty, field, label, select } from "./section";
import { OrderStatusChip } from "./status-chip";
import { newId, fmtWhen } from "./money";
import type { SuppliersResponse } from "./types";

// Purchase orders on a project: reference, supplier, lines and status. In
// manual CRM mode they are edited here (PATCH /api/finance/projects/[id]
// {supplierOrders}); synced projects show them read-only. Acknowledgements
// come from the order-acks queue and are shown, never edited, here.
const STATUSES: OrderStatus[] = ["draft", "pending_signoff", "signed_off", "sent", "acknowledged", "discrepancy", "confirmed", "cancelled"];
const TYPES: OrderType[] = ["contract", "addon", "remedial"];

export function SupplierOrdersEditor({ project, readOnly, onSaved }: { project: Project; readOnly: boolean; onSaved: (p: Project) => void }) {
  const { money2 } = useMoney();
  const [orders, setOrders] = React.useState<SupplierOrder[]>(project.supplierOrders || []);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const { data: suppliers } = useApi<SuppliersResponse>(readOnly ? null : "/api/finance/suppliers");
  const incoming = project.supplierOrders;
  React.useEffect(() => { setOrders(incoming || []); setDirty(false); }, [incoming]);

  const update = (id: string, patch: Partial<SupplierOrder>) => { setOrders((os) => os.map((o) => (o.id === id ? { ...o, ...patch, updatedAt: new Date().toISOString() } : o))); setDirty(true); };
  const updateLine = (id: string, i: number, patch: Partial<SupplierOrder["lines"][number]>) => { setOrders((os) => os.map((o) => (o.id === id ? { ...o, lines: o.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) } : o))); setDirty(true); };
  const addOrder = () => { const o: SupplierOrder = { id: newId("PO"), reference: "", supplierName: "", supplierId: null, status: "draft", orderType: "contract", lines: [{ code: "", description: "", qty: 1, unitCost: 0 }], orderedNet: null, ack: null, sentAt: null, createdAt: new Date().toISOString(), notes: null }; setOrders((os) => [...os, o]); setOpen(o.id); setDirty(true); };
  const removeOrder = (id: string) => { if (!window.confirm("Remove this purchase order?")) return; setOrders((os) => os.filter((o) => o.id !== id)); setDirty(true); };
  const save = async () => {
    for (const o of orders) if (!o.reference.trim() || !o.supplierName.trim()) { toast.error("Every order needs a reference and a supplier"); return; }
    setSaving(true);
    try {
      const clean = orders.map((o) => ({ ...o, reference: o.reference.trim(), supplierName: o.supplierName.trim(), lines: o.lines.filter((l) => l.code.trim() || l.description.trim()).map((l) => ({ ...l, qty: Number(l.qty) || 0, unitCost: Number(l.unitCost) || 0, ...(l.unitSell != null ? { unitSell: Number(l.unitSell) || 0 } : {}) })), ack: undefined }));
      const r = await api<{ project: Project }>(`/api/finance/projects/${encodeURIComponent(project.id)}`, { method: "PATCH", json: { supplierOrders: clean } });
      onSaved(r.project); setDirty(false); toast.success("Supplier orders saved");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Save failed"); } finally { setSaving(false); }
  };
  const profiles = suppliers?.profiles || [];

  return (
    <Section icon={Package} title="Supplier orders" hint={readOnly ? "Purchase orders come from your CRM. Acknowledgements matched in Finance Agents ▸ Order acks appear here." : "Purchase orders placed with suppliers. The reference is what the supplier quotes on its acknowledgement and invoice."}
      actions={!readOnly ? <><Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={addOrder}><Plus className="h-3 w-3" /> Add order</Button><Button size="sm" className="h-7 gap-1 text-xs" onClick={save} disabled={!dirty || saving}><Save className="h-3 w-3" /> {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}</Button></> : null}>
      {orders.length === 0 ? <Empty icon={Package}>No supplier orders{readOnly ? "" : " — add the purchase orders so acknowledgements and invoices can be matched to them"}.</Empty> : (
        <div className="space-y-2">
          {orders.map((o) => {
            const isOpen = open === o.id;
            const ackCost = acknowledgedCost(o);
            return (
              <div key={o.id} className="rounded-lg border border-border/60">
                <button type="button" className="flex w-full flex-wrap items-center gap-2 p-2.5 text-left text-sm" onClick={() => setOpen(isOpen ? null : o.id)} aria-expanded={isOpen}>
                  <span className="font-medium">{o.reference || <span className="text-muted-foreground">(no reference)</span>}</span>
                  <span className="text-muted-foreground">{o.supplierName || "—"}</span>
                  <OrderStatusChip status={o.status} />
                  <span className="text-[11px] text-muted-foreground">{o.orderType}</span>
                  <span className="ml-auto tabular-nums text-xs">{money2(orderedCost(o))} ordered{ackCost != null ? <span className={cn("ml-1", o.ack?.discrepancies.length ? "text-amber-600" : "text-emerald-600")}>· {money2(ackCost)} acknowledged</span> : null}</span>
                  {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
                {isOpen ? (
                  <div className="space-y-3 border-t border-border/40 p-3">
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                      <div><p className={label}>Reference (PO number)</p><input className={field} disabled={readOnly} value={o.reference} onChange={(e) => update(o.id, { reference: e.target.value })} /></div>
                      <div className="col-span-2 md:col-span-1"><p className={label}>Supplier</p>{profiles.length && !readOnly ? <input className={field} list={`suppliers-${o.id}`} value={o.supplierName} onChange={(e) => { const p = profiles.find((x) => x.vendorName === e.target.value); update(o.id, { supplierName: e.target.value, supplierId: p ? p.vendorId : null }); }} /> : <input className={field} disabled={readOnly} value={o.supplierName} onChange={(e) => update(o.id, { supplierName: e.target.value })} />}<datalist id={`suppliers-${o.id}`}>{profiles.map((p) => <option key={p.vendorId} value={p.vendorName} />)}</datalist></div>
                      <div><p className={label}>Type</p><select className={select} disabled={readOnly} value={o.orderType} onChange={(e) => update(o.id, { orderType: e.target.value as OrderType })}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
                      <div><p className={label}>Status</p><select className={select} disabled={readOnly} value={o.status} onChange={(e) => update(o.id, { status: e.target.value as OrderStatus })}>{STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}</select></div>
                      <div><p className={label}>Ordered net (override)</p><input className={field} type="number" inputMode="decimal" disabled={readOnly} value={o.orderedNet ?? ""} placeholder="Σ lines" onChange={(e) => update(o.id, { orderedNet: e.target.value === "" ? null : Number(e.target.value) })} /></div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[560px] text-xs">
                        <thead className="text-muted-foreground"><tr><th className="p-1 text-left font-medium">Code</th><th className="p-1 text-left font-medium">Description</th><th className="w-20 p-1 text-right font-medium">Qty</th><th className="w-28 p-1 text-right font-medium">Unit cost</th><th className="w-28 p-1 text-right font-medium">Unit sell</th><th className="w-24 p-1 text-right font-medium">Line</th>{!readOnly ? <th className="w-8 p-1" /> : null}</tr></thead>
                        <tbody>
                          {o.lines.map((l, i) => (
                            <tr key={i} className="border-t border-border/30">
                              <td className="p-1"><input className={select} disabled={readOnly} value={l.code} onChange={(e) => updateLine(o.id, i, { code: e.target.value })} /></td>
                              <td className="p-1"><input className={select} disabled={readOnly} value={l.description} onChange={(e) => updateLine(o.id, i, { description: e.target.value })} /></td>
                              <td className="p-1"><input className={cn(select, "text-right")} type="number" inputMode="decimal" disabled={readOnly} value={l.qty} onChange={(e) => updateLine(o.id, i, { qty: Number(e.target.value) })} /></td>
                              <td className="p-1"><input className={cn(select, "text-right")} type="number" inputMode="decimal" step="0.01" disabled={readOnly} value={l.unitCost} onChange={(e) => updateLine(o.id, i, { unitCost: Number(e.target.value) })} /></td>
                              <td className="p-1"><input className={cn(select, "text-right")} type="number" inputMode="decimal" step="0.01" disabled={readOnly} value={l.unitSell ?? ""} onChange={(e) => updateLine(o.id, i, { unitSell: e.target.value === "" ? undefined : Number(e.target.value) })} /></td>
                              <td className="p-1 text-right tabular-nums">{money2((Number(l.qty) || 0) * (Number(l.unitCost) || 0))}</td>
                              {!readOnly ? <td className="p-1 text-right"><button type="button" className="text-muted-foreground hover:text-red-500" aria-label="Remove line" onClick={() => { setOrders((os) => os.map((x) => (x.id === o.id ? { ...x, lines: x.lines.filter((_, k) => k !== i) } : x))); setDirty(true); }}><Trash2 className="h-3.5 w-3.5" /></button></td> : null}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!readOnly ? <div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => { setOrders((os) => os.map((x) => (x.id === o.id ? { ...x, lines: [...x.lines, { code: "", description: "", qty: 1, unitCost: 0 }] } : x))); setDirty(true); }}><Plus className="h-3 w-3" /> Add line</Button><Button variant="ghost" size="sm" className="h-7 gap-1 text-xs text-red-500" onClick={() => removeOrder(o.id)}><Trash2 className="h-3 w-3" /> Remove order</Button></div> : null}
                    <div><p className={label}>Notes</p><input className={field} disabled={readOnly} value={o.notes || ""} onChange={(e) => update(o.id, { notes: e.target.value || null })} /></div>
                    {o.ack ? (
                      <div className={cn("rounded-md border p-2 text-xs", o.ack.status === "match" ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5")}>
                        <p className="flex items-center gap-1 font-medium">{o.ack.status === "match" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />} Acknowledgement {o.ack.status === "match" ? "matches the order" : `with ${o.ack.discrepancies.length} discrepanc${o.ack.discrepancies.length === 1 ? "y" : "ies"}`} · received {fmtWhen(o.ack.receivedAt)}{o.ack.supplierRef ? ` · ref ${o.ack.supplierRef}` : ""}{o.ack.expectedDate ? ` · expected ${o.ack.expectedDate}` : ""}</p>
                        {o.ack.discrepancies.length ? <ul className="mt-1 space-y-0.5 text-muted-foreground">{o.ack.discrepancies.map((d, i) => <li key={i}>{d.lineCode}: {ACK_DISCREPANCY_LABEL[d.field]} — ordered {d.ordered}, acknowledged {d.acknowledged}</li>)}</ul> : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
