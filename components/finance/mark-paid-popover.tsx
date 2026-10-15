"use client";

import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PAYMENT_METHODS, type Invoice, type PaymentMethod } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import { api, useMoney } from "@/components/use-api";
import { ConfirmationField, type ConfirmSource } from "./confirmation-field";
import { invoiceTotal, SCHEDULE_LABEL, todayIso } from "./money";
import type { FinanceMutationResult } from "./types";

// The visible "Paid" button for a raised invoice. One server call marks the
// invoice paid AND records the payment on its schedule line, so the invoice
// status and the payment schedule always agree. The person clicking it must
// say how the receipt was verified — the server refuses without it.
export function MarkPaidPopover({ projectId, invoice, onDone, size = "sm", className }: { projectId: string; invoice: Invoice; onDone: (result: FinanceMutationResult) => void; size?: "xs" | "sm"; className?: string }) {
  const { money2 } = useMoney();
  const [open, setOpen] = React.useState(false);
  const [method, setMethod] = React.useState<PaymentMethod>("Bank Transfer");
  const [date, setDate] = React.useState(todayIso());
  const [record, setRecord] = React.useState(!!invoice.scheduleKey);
  const [confirmSource, setConfirmSource] = React.useState<ConfirmSource>("");
  const [confirmRef, setConfirmRef] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const total = invoiceTotal(invoice);
  const lineLabel = invoice.scheduleKey ? SCHEDULE_LABEL[invoice.scheduleKey] : null;
  const scheduleKey = invoice.scheduleKey;
  React.useEffect(() => { if (open) { setMethod("Bank Transfer"); setDate(todayIso()); setRecord(!!scheduleKey); setConfirmSource(""); setConfirmRef(""); } }, [open, scheduleKey]);

  const submit = async () => {
    if (!confirmSource) { toast.error("Say how the receipt was verified first"); return; }
    setBusy(true);
    try {
      const data = await api<FinanceMutationResult>(`/api/finance/projects/${encodeURIComponent(projectId)}/finance`, { method: "POST", json: { action: "mark_invoice_paid", invoiceId: invoice.id, paidAt: date, method, recordPayment: record, confirmation: { source: confirmSource, ref: confirmRef.trim() || null } } });
      toast.success(data.payment ? `Invoice ${invoice.number} marked paid · ${money2(data.payment.amount)} payment recorded` : `Invoice ${invoice.number} marked paid`);
      onDone(data); setOpen(false);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Update failed"); } finally { setBusy(false); }
  };

  return (
    <Popover open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("gap-1 border-green-600/40 text-green-700 hover:bg-green-600/10 hover:text-green-700 dark:text-green-400", size === "xs" ? "h-7 px-2 text-[11px]" : "h-8 text-xs", className)} title={`Mark ${invoice.number} as paid`}>
          <CheckCircle2 className="h-3.5 w-3.5" /> Paid
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(18rem,calc(100vw-2rem))] space-y-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><CheckCircle2 className="h-3.5 w-3.5 text-green-600" /> {invoice.number} paid</p>
        <p className="text-[11px] text-muted-foreground">{money2(total)} inc VAT{lineLabel ? ` · ${lineLabel}` : ""}</p>
        <div className="grid grid-cols-2 gap-2">
          <Input type="date" className="h-8 text-sm" value={date} onChange={(e) => setDate(e.target.value)} title="Date paid" aria-label="Date paid" />
          <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
            <SelectTrigger className="h-8 text-sm" aria-label="Payment method"><SelectValue /></SelectTrigger>
            <SelectContent>{PAYMENT_METHODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <label className="flex cursor-pointer select-none items-start gap-2 text-xs">
          <Checkbox checked={record} onCheckedChange={(c) => setRecord(c === true)} className="mt-0.5" />
          <span>Also record the {money2(total)} payment{lineLabel ? ` on ${lineLabel}` : ""} so the schedule shows it paid{invoice.scheduleKey ? "" : " (fills the schedule in order)"}</span>
        </label>
        <ConfirmationField source={confirmSource} onSource={setConfirmSource} reference={confirmRef} onReference={setConfirmRef} />
        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={busy || !confirmSource} className="bg-green-600 text-white hover:bg-green-700">{busy ? "Saving…" : "Confirm paid"}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
