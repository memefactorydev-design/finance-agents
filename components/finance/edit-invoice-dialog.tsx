"use client";

import * as React from "react";
import { Pencil, Link2, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { Invoice } from "@/lib/crm/types";
import { api, useMoney } from "@/components/use-api";
import { MoneyField } from "./money-field";
import { invoiceTotal, SCHEDULE_LABEL, fmtDate } from "./money";
import type { FinanceMutationResult } from "./types";

// Edit a raised invoice (draft or sent): description, due date, payment link,
// note, VAT rate and — for the owner — the gross amount, which also rewrites
// the schedule line it bills.
export function EditInvoiceDialog({ open, onOpenChange, projectId, invoice, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; projectId: string; invoice: Invoice | null; onSaved: (r: FinanceMutationResult) => void }) {
  const { money2 } = useMoney();
  const [description, setDescription] = React.useState("");
  const [dueDate, setDueDate] = React.useState("");
  const [paymentLink, setPaymentLink] = React.useState("");
  const [note, setNote] = React.useState("");
  const [vatRate, setVatRate] = React.useState("20");
  const [amountGross, setAmountGross] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open || !invoice) return;
    setDescription(invoice.items[0]?.description || ""); setDueDate(invoice.dueDate || ""); setPaymentLink(invoice.paymentLink || ""); setNote(invoice.note || ""); setVatRate(String(invoice.vatRate)); setAmountGross(invoiceTotal(invoice)); setBusy(false);
  }, [open, invoice]);

  if (!invoice) return null;
  const locked = invoice.status === "paid" || invoice.status === "void";
  const multiLine = invoice.items.length > 1;
  const originalTotal = invoiceTotal(invoice);

  const submit = async () => {
    const body: Record<string, unknown> = { action: "edit_invoice", invoiceId: invoice.id };
    let changed = false;
    if (description.trim() && description.trim() !== (invoice.items[0]?.description || "")) { body.description = description.trim(); changed = true; }
    if ((dueDate || null) !== (invoice.dueDate || null)) { body.dueDate = dueDate || null; changed = true; }
    if ((paymentLink || "") !== (invoice.paymentLink || "")) { body.paymentLink = paymentLink || null; changed = true; }
    if ((note || "") !== (invoice.note || "")) { body.note = note || null; changed = true; }
    const vat = parseFloat(vatRate);
    if (!Number.isNaN(vat) && vat !== invoice.vatRate) { body.vatRate = vat; changed = true; }
    if (!multiLine && amountGross != null && Math.abs(amountGross - originalTotal) >= 0.005) { body.amountGross = amountGross; changed = true; }
    if (!changed) { onOpenChange(false); return; }
    setBusy(true);
    try {
      const data = await api<FinanceMutationResult>(`/api/finance/projects/${encodeURIComponent(projectId)}/finance`, { method: "POST", json: body });
      toast.success(`Invoice ${invoice.number} updated`);
      onSaved(data); onOpenChange(false);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Update failed"); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Pencil className="h-4 w-4 text-primary" /> Edit invoice {invoice.number}</DialogTitle>
          <DialogDescription>{invoice.scheduleKey ? `${SCHEDULE_LABEL[invoice.scheduleKey]} · ` : ""}raised {fmtDate(invoice.date)} · currently {money2(originalTotal)} inc VAT.</DialogDescription>
        </DialogHeader>
        {locked ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Lock className="h-4 w-4" /> A {invoice.status} invoice can&apos;t be edited. Void it and raise a new one if something is wrong.</p>
        ) : (
          <div className="space-y-3">
            <div><p className="mb-1 text-xs text-muted-foreground">Description (printed on the invoice)</p><Input className="h-9" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><p className="mb-1 text-xs text-muted-foreground">Due date</p><Input className="h-9" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
              <div><p className="mb-1 text-xs text-muted-foreground">VAT rate %</p><Input className="h-9" type="number" min={0} max={100} step={0.5} value={vatRate} onChange={(e) => setVatRate(e.target.value)} title="Changing VAT keeps the gross total the same" /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Amount inc VAT</p>
                {!multiLine ? <MoneyField value={amountGross} onCommit={(v) => setAmountGross(v)} title="Changes the schedule line amount too" /> : <p className="flex h-9 items-center px-1 text-sm font-semibold tabular-nums">{money2(originalTotal)}</p>}
                {!multiLine ? <p className="mt-1 text-[10px] text-muted-foreground">Updates the payment schedule line to match</p> : null}
              </div>
              <div><p className="mb-1 flex items-center gap-1 text-xs text-muted-foreground"><Link2 className="h-3 w-3" /> Payment link (optional)</p><Input className="h-9" placeholder="https://pay.example.com/…" value={paymentLink} onChange={(e) => setPaymentLink(e.target.value.trim())} /></div>
            </div>
            <div><p className="mb-1 text-xs text-muted-foreground">Note to client (optional)</p><Textarea className="min-h-[60px]" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></div>
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{locked ? "Close" : "Cancel"}</Button>
          {!locked ? <Button onClick={submit} disabled={busy || !description.trim()} className="gap-1.5"><Pencil className="h-4 w-4" /> {busy ? "Saving…" : "Save changes"}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
