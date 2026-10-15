"use client";

import * as React from "react";
import { FileText, Link2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ScheduleKey } from "@/lib/crm/types";
import { api, useMoney } from "@/components/use-api";
import { MoneyField } from "./money-field";
import { LineStatusChip } from "./status-chip";
import { netFromGross } from "./money";
import type { FinanceMutationResult, ResolvedLine } from "./types";

const DESCRIPTIONS: Record<ScheduleKey, string> = {
  deposit: "Deposit due on order",
  survey_payment: "Survey order payment",
  delivery_balance: "Delivery balance",
  install_deposit: "Installation deposit",
  install_day1: "Installation — payment due Day 1",
  install_stage1: "Installation — payment due on Stage 1 sign-off",
  retention: "Installation retention — released on Stage 2 sign-off",
};

// Raise a numbered customer invoice for one schedule line. Two ways in: a
// fixed `line` (the Raise button on a schedule row) or a list of `lines` to
// pick from (the New invoice button). Raising for a different gross amount
// rewrites the schedule line to match. No agent ever creates these.
export function RaiseInvoiceDialog({ open, onOpenChange, projectId, line, lines, onRaised }: { open: boolean; onOpenChange: (open: boolean) => void; projectId: string; line: ResolvedLine | null; lines?: ResolvedLine[]; onRaised: (r: FinanceMutationResult) => void }) {
  const { money2 } = useMoney();
  const choosing = !line && !!lines;
  const [selectedKey, setSelectedKey] = React.useState<ScheduleKey | "">("");
  const current: ResolvedLine | null = line ?? (lines || []).find((l) => l.key === selectedKey) ?? null;
  const [description, setDescription] = React.useState("");
  const [dueDate, setDueDate] = React.useState("");
  const [note, setNote] = React.useState("");
  const [paymentLink, setPaymentLink] = React.useState("");
  const [amountGross, setAmountGross] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => { if (!open) return; setSelectedKey(line?.key ?? lines?.[0]?.key ?? ""); setNote(""); setPaymentLink(""); setBusy(false); }, [open, line, lines]);
  const currentKey = current?.key, currentAmount = current?.amountGross, currentDue = current?.dueDate;
  React.useEffect(() => {
    if (!open || !currentKey) return;
    setDescription(DESCRIPTIONS[currentKey]);
    setDueDate(currentDue || new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
    setAmountGross(currentAmount ?? null);
  }, [open, currentKey, currentAmount, currentDue]);

  const overriding = current != null && amountGross != null && Math.abs(amountGross - current.amountGross) >= 0.005;
  const gross = amountGross ?? current?.amountGross ?? 0;
  const net = current ? netFromGross(gross, current.vatRate) : 0;

  const submit = async () => {
    if (!current) return;
    if (overriding && (!amountGross || amountGross <= 0)) { toast.error("Enter an amount inc VAT"); return; }
    setBusy(true);
    try {
      const data = await api<FinanceMutationResult>(`/api/finance/projects/${encodeURIComponent(projectId)}/finance`, { method: "POST", json: { action: "raise_invoice", scheduleKey: current.key, dueDate: dueDate || undefined, note: note || undefined, paymentLink: paymentLink || undefined, description: description || undefined, ...(overriding ? { amountGross } : {}) } });
      toast.success(data.invoice ? `Invoice ${data.invoice.number} raised` : "Invoice raised");
      onRaised(data); onOpenChange(false);
    } catch (e) { toast.error(`Invoice not raised — ${e instanceof Error ? e.message : "unknown error"}`); } finally { setBusy(false); }
  };

  if (!line && !lines) return null;
  const nothingToRaise = choosing && (lines || []).length === 0;
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileText className="h-4 w-4 text-primary" /> {choosing ? "New invoice" : `Raise invoice — ${current?.label}`}</DialogTitle>
          <DialogDescription>
            {nothingToRaise ? "Every payment on the schedule is already invoiced or paid. Add a schedule line or void an invoice to raise another." : current ? `${money2(gross)} inc VAT (${money2(net)} net + ${money2(gross - net)} VAT @ ${current.vatRate}%).` : "Choose which scheduled payment to invoice."}
          </DialogDescription>
        </DialogHeader>
        {!nothingToRaise ? (
          <div className="space-y-3">
            {choosing ? (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Payment to invoice</p>
                <Select value={selectedKey} onValueChange={(v) => setSelectedKey(v as ScheduleKey)}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="Choose a schedule line" /></SelectTrigger>
                  <SelectContent>{(lines || []).map((l) => <SelectItem key={l.key} value={l.key}><span className="flex items-center gap-2"><span>{l.label}</span><span className="tabular-nums text-muted-foreground">{money2(l.amountGross)}</span><LineStatusChip status={l.status} /></span></SelectItem>)}</SelectContent>
                </Select>
                {current ? <p className="mt-1 text-[11px] text-muted-foreground">{current.trigger}{current.paidGross > 0 ? ` · ${money2(current.paidGross)} already paid on this line` : ""}</p> : null}
              </div>
            ) : null}
            <div><p className="mb-1 text-xs text-muted-foreground">Description (printed on the invoice)</p><Input className="h-9" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Amount inc VAT</p>
                <MoneyField value={amountGross} onCommit={(v) => setAmountGross(v)} title="Raise for a different amount — the schedule line is updated to match" />
                {overriding && current ? <p className="mt-1 text-[10px] text-amber-600">Schedule line was {money2(current.amountGross)} — it will be set to {money2(gross)}</p> : null}
              </div>
              <div><p className="mb-1 text-xs text-muted-foreground">Due date</p><Input className="h-9" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
            </div>
            <div><p className="mb-1 flex items-center gap-1 text-xs text-muted-foreground"><Link2 className="h-3 w-3" /> Payment link (optional)</p><Input className="h-9" placeholder="https://pay.example.com/…" value={paymentLink} onChange={(e) => setPaymentLink(e.target.value.trim())} /></div>
            <div><p className="mb-1 text-xs text-muted-foreground">Note to client (optional)</p><Textarea className="min-h-[60px]" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Thank you for your order — installation is booked for…" /></div>
          </div>
        ) : null}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{nothingToRaise ? "Close" : "Cancel"}</Button>
          {!nothingToRaise ? <Button onClick={submit} disabled={busy || !current || !description.trim()} className="gap-1.5"><FileText className="h-4 w-4" /> {busy ? "Raising…" : "Raise invoice"}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
