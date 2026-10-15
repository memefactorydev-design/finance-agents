"use client";

import * as React from "react";
import { Receipt } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EXTRA_COST_CATEGORIES, type ExtraCostCategory } from "@/lib/crm/types";
import { api, useMoney } from "@/components/use-api";
import { todayIso } from "./money";
import type { FinanceMutationResult } from "./types";

// Manual non-order spend (extra fitter day, skip, local purchase). Counted in
// the Completion P&L when dated on or before Stage 2 sign-off.
export function ExtraCostDialog({ open, onOpenChange, projectId, projectName, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; projectId: string; projectName: string; onSaved: (r: FinanceMutationResult) => void }) {
  const { symbol } = useMoney();
  const [amount, setAmount] = React.useState("");
  const [date, setDate] = React.useState(todayIso());
  const [category, setCategory] = React.useState<ExtraCostCategory>("Labour");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) { setAmount(""); setDescription(""); setDate(todayIso()); } }, [open]);
  const save = async () => {
    const value = parseFloat(amount);
    if (!value || value <= 0 || !description.trim()) { toast.error("Enter an amount and a description"); return; }
    setBusy(true);
    try {
      const data = await api<FinanceMutationResult>(`/api/finance/projects/${encodeURIComponent(projectId)}/finance`, { method: "POST", json: { action: "add_extra_cost", amount: Math.round(value * 100) / 100, date, category, description: description.trim() } });
      onSaved(data); onOpenChange(false); toast.success(`Extra cost recorded against ${projectName}`);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Save failed"); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Receipt className="h-4 w-4 text-orange-600" /> Extra cost — {projectName}</DialogTitle>
          <DialogDescription>Net spend outside supplier orders. Counts against the Completion P&amp;L when dated on or before Stage 2 sign-off.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><p className="mb-1 text-xs text-muted-foreground">Amount {symbol} (net)</p><Input type="number" inputMode="decimal" className="h-9" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
            <div><p className="mb-1 text-xs text-muted-foreground">Date</p><Input type="date" className="h-9" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Category</p>
            <Select value={category} onValueChange={(v) => setCategory(v as ExtraCostCategory)}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{EXTRA_COST_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><p className="mb-1 text-xs text-muted-foreground">Description</p><Input className="h-9" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Extra fitter day — worktop re-template" maxLength={300} /></div>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Record cost"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
