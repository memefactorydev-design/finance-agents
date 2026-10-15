"use client";

import * as React from "react";
import { Ban, MoreHorizontal, FileText, Pencil, Trash2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { Invoice } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import { api, useMoney } from "@/components/use-api";
import { InvoiceStatusChip } from "./status-chip";
import { MarkPaidPopover } from "./mark-paid-popover";
import { invoiceTotal, fmtDate } from "./money";
import type { FinanceMutationResult } from "./types";

// Chip + menu for a raised invoice (mark sent, edit, delete, void) with the
// visible Paid button beside it. Status changes go through the project
// finance route, which returns the fresh project and schedule.
export function InvoiceActions({ projectId, invoice, onEdit, onDelete, onChanged, compact = false, showPaid = true, className }: {
  projectId: string; invoice: Invoice; onEdit?: (invoice: Invoice) => void; onDelete?: (invoice: Invoice) => void; onChanged: (r: FinanceMutationResult) => void; compact?: boolean; showPaid?: boolean; className?: string;
}) {
  const { money2 } = useMoney();
  const [busy, setBusy] = React.useState(false);
  const open = invoice.status === "draft" || invoice.status === "sent";
  const setStatus = async (status: "sent" | "void") => {
    if (status === "void" && !window.confirm(`Void invoice ${invoice.number}? The line can then be re-invoiced.`)) return;
    setBusy(true);
    try {
      const data = await api<FinanceMutationResult>(`/api/finance/projects/${encodeURIComponent(projectId)}/finance`, { method: "POST", json: { action: "set_invoice_status", invoiceId: invoice.id, status } });
      onChanged(data); toast.success(`Invoice ${invoice.number} marked ${status}`);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Update failed"); } finally { setBusy(false); }
  };
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={busy} className="h-7 gap-1.5 px-1.5 font-normal" title={`${invoice.number} · ${money2(invoiceTotal(invoice))}`}>
            <FileText className="h-3.5 w-3.5 text-primary" />
            {!compact ? <span className="text-xs font-medium">{invoice.number}</span> : null}
            <InvoiceStatusChip status={invoice.status} />
            <MoreHorizontal className="h-3 w-3 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {invoice.number} · {money2(invoiceTotal(invoice))}
            {invoice.sentAt ? <div>Sent {fmtDate(invoice.sentAt)}{invoice.emailedTo ? ` to ${invoice.emailedTo}` : ""}</div> : null}
            {invoice.status === "paid" && invoice.paidAt ? <div className="text-green-600">Paid {fmtDate(invoice.paidAt)}</div> : null}
          </div>
          <DropdownMenuSeparator />
          {invoice.status === "draft" ? <DropdownMenuItem onClick={() => setStatus("sent")}><Send className="mr-2 h-4 w-4" /> Mark as sent</DropdownMenuItem> : null}
          {open && onEdit ? <DropdownMenuItem onClick={() => onEdit(invoice)}><Pencil className="mr-2 h-4 w-4" /> Edit invoice…</DropdownMenuItem> : null}
          {(invoice.status !== "void" || onDelete) ? <DropdownMenuSeparator /> : null}
          {invoice.status !== "void" ? <DropdownMenuItem destructive onClick={() => setStatus("void")}><Ban className="mr-2 h-4 w-4" /> Void invoice</DropdownMenuItem> : null}
          {onDelete ? <DropdownMenuItem destructive onClick={() => onDelete(invoice)}><Trash2 className="mr-2 h-4 w-4" /> Delete invoice…</DropdownMenuItem> : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {open && showPaid ? <MarkPaidPopover projectId={projectId} invoice={invoice} size="xs" onDone={onChanged} /> : null}
    </span>
  );
}
