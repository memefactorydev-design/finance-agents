"use client";

import * as React from "react";
import { Wallet, Building2, Inbox, PackageCheck, BookOpen, Scale, Bot, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { QuickBooksCard } from "./quickbooks-card";
import { CashflowSection } from "./cashflow-section";
import { SupplierBalances } from "./supplier-balances";
import { SupplierInvoicesQueue } from "./supplier-invoices-queue";
import { OrderAcksQueue } from "./order-acks-queue";
import { SupplierPlaybook } from "./supplier-playbook";
import { DisputeRegister } from "./dispute-register";
import { FinanceAgentsRoster } from "./finance-agents-roster";
import { JobsHealth } from "./jobs-health";
import type { StatusResponse } from "./types";

// Finance Agents: one view per section. Each view mounts when first opened
// and stays mounted, so switching back does not refetch. The active view
// lives in the URL (?tab=agents&view=…) so links from briefs land on it.
export const AGENT_VIEWS = [
  { key: "cashflow", label: "Cashflow", icon: Wallet, hint: "Bank balance, expected receipts, supplier bills — 13 weeks" },
  { key: "balances", label: "Supplier balances", icon: Building2, hint: "Open bills and credits by supplier, from QuickBooks" },
  { key: "invoices", label: "Supplier invoices", icon: Inbox, hint: "Invoices found in the mailboxes, coded for QuickBooks" },
  { key: "acks", label: "Order acks", icon: PackageCheck, hint: "Supplier acknowledgements matched to purchase orders" },
  { key: "playbook", label: "Supplier playbook", icon: BookOpen, hint: "Terms, pressure, payment methods and standing commitments" },
  { key: "disputes", label: "Disputes", icon: Scale, hint: "Dispute register — excluded from payments and chasing" },
  { key: "agents", label: "Agents", icon: Bot, hint: "The F0–F9 roster, schedule and latest briefs" },
  { key: "jobs", label: "Jobs & health", icon: Activity, hint: "Connections, scheduled jobs and run-now" },
] as const;
export type AgentView = (typeof AGENT_VIEWS)[number]["key"];
export const isAgentView = (v: string | null | undefined): v is AgentView => !!v && AGENT_VIEWS.some((x) => x.key === v);
export interface AgentBadges { intakeOpen: number; acksOpen: number; disputesOpen: number }

export function FinanceAgentsPanel({ status, statusLoading, onStatusReload, view, onViewChange, badges }: {
  status: StatusResponse | null;
  statusLoading: boolean;
  onStatusReload: () => void;
  view: AgentView;
  onViewChange: (v: AgentView) => void;
  badges: AgentBadges;
}) {
  const [mounted, setMounted] = React.useState<Set<AgentView>>(() => new Set([view]));
  React.useEffect(() => { setMounted((m) => (m.has(view) ? m : new Set(m).add(view))); }, [view]);
  const connected = !!status?.quickbooks.connected;
  const badgeFor = (k: AgentView) => (k === "invoices" ? badges.intakeOpen : k === "acks" ? badges.acksOpen : k === "disputes" ? badges.disputesOpen : 0);
  const active = AGENT_VIEWS.find((v) => v.key === view) || AGENT_VIEWS[0];

  return (
    <div className="space-y-4">
      <QuickBooksCard quickbooks={status?.quickbooks || null} onChanged={onStatusReload} />
      <div className="sticky top-14 z-10 -mx-1 rounded-lg bg-background/95 px-1 py-1 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div role="tablist" aria-label="Finance agents sections" className="scrollbar-none flex gap-1 overflow-x-auto pb-1">
          {AGENT_VIEWS.map((v) => {
            const n = badgeFor(v.key); const Icon = v.icon; const selected = v.key === view;
            return (
              <button key={v.key} type="button" role="tab" aria-selected={selected} title={v.hint} onClick={() => onViewChange(v.key)}
                className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors", selected ? "border-foreground bg-foreground text-background" : "border-border/60 text-muted-foreground hover:bg-muted/50 hover:text-foreground")}>
                <Icon className="h-3.5 w-3.5" /> {v.label}
                {n > 0 ? <span className={cn("ml-0.5 rounded-full px-1.5 text-[10px] tabular-nums", selected ? "bg-background/20 text-background" : "bg-amber-500/15 text-amber-700 dark:text-amber-300")}>{n}</span> : null}
              </button>
            );
          })}
        </div>
        <p className="px-1 pt-1 text-[11px] text-muted-foreground">{active.hint}</p>
      </div>

      {mounted.has("cashflow") ? <div hidden={view !== "cashflow"}><CashflowSection connected={connected} /></div> : null}
      {mounted.has("balances") ? <div hidden={view !== "balances"}><SupplierBalances connected={connected} /></div> : null}
      {mounted.has("invoices") ? <div hidden={view !== "invoices"}><SupplierInvoicesQueue connected={connected} /></div> : null}
      {mounted.has("acks") ? <div hidden={view !== "acks"}><OrderAcksQueue connected={connected} /></div> : null}
      {mounted.has("playbook") ? <div hidden={view !== "playbook"}><SupplierPlaybook connected={connected} /></div> : null}
      {mounted.has("disputes") ? <div hidden={view !== "disputes"}><DisputeRegister connected={connected} /></div> : null}
      {mounted.has("agents") ? <div hidden={view !== "agents"}><FinanceAgentsRoster /></div> : null}
      {mounted.has("jobs") ? <div hidden={view !== "jobs"}><JobsHealth status={status} loading={statusLoading} onReload={onStatusReload} /></div> : null}
    </div>
  );
}
