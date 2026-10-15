"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { LineStatus } from "@/lib/crm/schedule";
import type { InvoiceStatus, OrderStatus, ProjectStatus } from "@/lib/crm/types";

const LINE_STYLES: Record<LineStatus, { label: string; cls: string }> = {
  "n/a": { label: "n/a", cls: "bg-muted text-muted-foreground" },
  tbc: { label: "Date TBC", cls: "bg-muted text-muted-foreground" },
  upcoming: { label: "Upcoming", cls: "bg-sky-500/10 text-sky-600 dark:text-sky-400" },
  due: { label: "Due", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  overdue: { label: "Overdue", cls: "bg-red-500/15 text-red-500" },
  part: { label: "Part paid", cls: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
  paid: { label: "Paid", cls: "bg-green-500/15 text-green-600 dark:text-green-400" },
};
export function LineStatusChip({ status, className }: { status: LineStatus; className?: string }) {
  const s = LINE_STYLES[status];
  return <Badge className={cn("border-0 text-[10px] font-medium shadow-none", s.cls, className)}>{s.label}</Badge>;
}

const INVOICE_STYLES: Record<InvoiceStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  sent: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  paid: "bg-green-500/15 text-green-600 dark:text-green-400",
  void: "bg-red-500/10 text-red-500 line-through",
};
export function InvoiceStatusChip({ status, className }: { status: InvoiceStatus; className?: string }) {
  return <Badge className={cn("border-0 text-[10px] capitalize shadow-none", INVOICE_STYLES[status], className)}>{status}</Badge>;
}

const PROJECT_STYLES: Record<ProjectStatus, string> = {
  active: "bg-primary/10 text-primary",
  completed: "bg-green-500/15 text-green-600 dark:text-green-400",
  cancelled: "bg-muted text-muted-foreground line-through",
  lost: "bg-red-500/10 text-red-500",
};
export function ProjectStatusChip({ status, className }: { status: ProjectStatus; className?: string }) {
  return <Badge className={cn("border-0 text-[10px] capitalize shadow-none", PROJECT_STYLES[status], className)}>{status}</Badge>;
}

const ORDER_STYLES: Record<OrderStatus, string> = {
  draft: "bg-muted text-muted-foreground", pending_signoff: "bg-amber-500/15 text-amber-600 dark:text-amber-400", signed_off: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  sent: "bg-blue-500/15 text-blue-600 dark:text-blue-400", acknowledged: "bg-green-500/15 text-green-600 dark:text-green-400", discrepancy: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  confirmed: "bg-green-500/20 text-green-700 dark:text-green-300", cancelled: "bg-muted text-muted-foreground line-through",
};
export function OrderStatusChip({ status, className }: { status: OrderStatus; className?: string }) {
  return <Badge className={cn("border-0 text-[10px] shadow-none", ORDER_STYLES[status], className)}>{status.replace(/_/g, " ")}</Badge>;
}
