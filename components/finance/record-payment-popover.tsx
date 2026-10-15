"use client";

import * as React from "react";
import { Coins } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/crm/types";
import { api, useMoney } from "@/components/use-api";
import { ConfirmationField, type ConfirmSource } from "./confirmation-field";
import { todayIso } from "./money";
import type { FinanceMutationResult, ResolvedLine } from "./types";

// Record a gross payment against one schedule line (tagged with scheduleKey
// so the schedule, the payments ledger and the KPIs all agree). The recorder
// states how the receipt was verified; it is stored on the payment.
export function RecordPaymentPopover({ projectId, line, onDone, children }: { projectId: string; line: ResolvedLine; onDone: (r: FinanceMutationResult) => void; children: React.ReactNode }) {
  const { money2, symbol } = useMoney();
  const [open, setOpen] = React.useState(false);
  const [amount, setAmount] = React.useState("");
  const [method, setMethod] = React.useState<PaymentMethod>("Bank Transfer");
  const [date, setDate] = React.useState(todayIso());
  const [note, setNote] = React.useState("");
  const [confirmSource, setConfirmSource] = React.useState<ConfirmSource>("");
  const [confirmRef, setConfirmRef] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const outstanding = line.outstandingGross;
  React.useEffect(() => { if (open) { setAmount(outstanding > 0 ? String(outstanding) : ""); setDate(todayIso()); setNote(""); setConfirmSource(""); setConfirmRef(""); } }, [open, outstanding]);

  const save = async () => {
    const value = parseFloat(amount);
    if (!value || value <= 0) { toast.error("Enter a payment amount"); return; }
    if (!confirmSource) { toast.error("Say how the receipt was verified first"); return; }
    setSaving(true);
    try {
      const r = await api<FinanceMutationResult>(`/api/finance/projects/${encodeURIComponent(projectId)}/finance`, { method: "POST", json: { action: "record_payment", amount: Math.round(value * 100) / 100, date, method, note: note || undefined, scheduleKey: line.key, confirmation: { source: confirmSource, ref: confirmRef.trim() || null } } });
      toast.success(`${money2(value)} recorded on ${line.label}`);
      onDone(r); setOpen(false);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Save failed"); } finally { setSaving(false); }
  };

  return (
    <Popover open={open} onOpenChange={(o) => !saving && setOpen(o)}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-[min(18rem,calc(100vw-2rem))] space-y-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><Coins className="h-3.5 w-3.5 text-money" /> Record payment — {line.label}</p>
        <p className="text-[11px] text-muted-foreground">Amounts are inc VAT. Outstanding on this line: {money2(line.outstandingGross)}</p>
        <div className="grid grid-cols-2 gap-2">
          <Input type="number" inputMode="decimal" className="h-8 text-sm" placeholder={`Amount ${symbol}`} aria-label="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Input type="date" className="h-8 text-sm" aria-label="Date received" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
          <SelectTrigger className="h-8 text-sm" aria-label="Payment method"><SelectValue /></SelectTrigger>
          <SelectContent>{PAYMENT_METHODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
        </Select>
        <Input className="h-8 text-sm" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <ConfirmationField source={confirmSource} onSource={setConfirmSource} reference={confirmRef} onReference={setConfirmRef} hint="Required." />
        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving || !confirmSource}>{saving ? "Saving…" : "Record"}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
