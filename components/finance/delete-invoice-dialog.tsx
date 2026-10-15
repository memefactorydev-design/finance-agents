"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { Invoice, Payment } from "@/lib/crm/types";
import { api, useMoney } from "@/components/use-api";
import { invoiceTotal, SCHEDULE_LABEL } from "./money";
import type { FinanceMutationResult } from "./types";

// Confirm + delete. Spells out what goes with it (the auto-recorded payment)
// and that the number is never reused.
export function DeleteInvoiceDialog({ open, onOpenChange, projectId, invoice, payments, onDeleted }: { open: boolean; onOpenChange: (open: boolean) => void; projectId: string; invoice: Invoice | null; payments?: Payment[] | null; onDeleted: (r: FinanceMutationResult) => void }) {
  const { money2 } = useMoney();
  const [busy, setBusy] = React.useState(false);
  if (!invoice) return null;
  const total = invoiceTotal(invoice);
  const label = invoice.scheduleKey ? SCHEDULE_LABEL[invoice.scheduleKey] : null;
  const autoPayment = invoice.status === "paid" ? (payments || []).filter((p) => (p.note || "") === `Invoice ${invoice.number}` && (p.scheduleKey ?? null) === (invoice.scheduleKey ?? null)) : [];
  const autoTotal = autoPayment.reduce((s, p) => s + p.amount, 0);
  const confirm = async () => {
    setBusy(true);
    try {
      const data = await api<FinanceMutationResult>(`/api/finance/projects/${encodeURIComponent(projectId)}/finance`, { method: "POST", json: { action: "delete_invoice", invoiceId: invoice.id } });
      toast.success(`Invoice ${invoice.number} deleted${data.removedPayments?.length ? ` · ${money2(data.removedPayments.reduce((s, p) => s + p.amount, 0))} payment removed` : ""}`);
      onDeleted(data); onOpenChange(false);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Delete failed"); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Trash2 className="h-4 w-4 text-red-500" /> Delete invoice {invoice.number}?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>{money2(total)} inc VAT{label ? ` for ${label}` : ""} · currently <span className="font-medium capitalize">{invoice.status}</span>.</p>
              <ul className="list-disc space-y-1 pl-4">
                {label ? <li>{label} is unlinked and can be invoiced again.</li> : null}
                {invoice.status === "paid" ? (payments === undefined ? <li>The payment that <em>Paid</em> recorded for it (if any) is removed too. Payments entered by hand stay.</li> : autoPayment.length ? <li>The {money2(autoTotal)} payment that <em>Paid</em> recorded is removed too. Payments entered by hand stay.</li> : <li>No automatic payment is attached — the payments ledger is left as it is.</li>) : null}
                {invoice.status === "sent" ? <li className="text-amber-600">The client has received this invoice. Prefer <em>Void</em> if they may still refer to it.</li> : null}
                <li>Number {invoice.number} is never reused.</li>
              </ul>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Keep it</Button>
          <Button variant="destructive" onClick={confirm} disabled={busy}>{busy ? "Deleting…" : "Delete invoice"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
