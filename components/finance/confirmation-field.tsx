"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PAYMENT_CONFIRMATION_LABEL, type PaymentConfirmationSource } from "@/lib/crm/types";

// The verification source every receipt needs before it is recorded or an
// invoice is marked paid: bank statement, the owner, the finance provider's
// payout or a card terminal receipt. Never the client's word. The server
// refuses writes without it; this field makes the rule visible.
export const CONFIRM_OPTIONS: PaymentConfirmationSource[] = ["bank_statement", "owner", "finance_provider", "card_terminal"];
export type ConfirmSource = PaymentConfirmationSource | "";

export function ConfirmationField({ source, onSource, reference, onReference, hint = "Required — never on the client's word." }: { source: ConfirmSource; onSource: (s: PaymentConfirmationSource) => void; reference: string; onReference: (r: string) => void; hint?: string }) {
  return (
    <div className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
      <p className="text-[11px] font-medium text-amber-800 dark:text-amber-300">How was the receipt verified? <span className="font-normal text-muted-foreground">{hint}</span></p>
      <Select value={source} onValueChange={(v) => onSource(v as PaymentConfirmationSource)}>
        <SelectTrigger className="h-8 text-sm" aria-label="Verification source"><SelectValue placeholder="Choose…" /></SelectTrigger>
        <SelectContent>{CONFIRM_OPTIONS.map((c) => <SelectItem key={c} value={c}>{PAYMENT_CONFIRMATION_LABEL[c]}</SelectItem>)}</SelectContent>
      </Select>
      <Input className="h-8 text-sm" placeholder="Reference (bank line, payout id) — optional" value={reference} onChange={(e) => onReference(e.target.value)} maxLength={120} />
    </div>
  );
}
