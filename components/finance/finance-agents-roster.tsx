"use client";

import * as React from "react";
import Link from "next/link";
import { Bot, MessageSquare, ExternalLink, ShieldCheck, Clock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useApi, useCompany } from "@/components/use-api";
import { RefreshButton, ErrorNote, Empty, TH, THEAD } from "./section";
import { ago } from "./money";
import type { BriefsResponse } from "./types";

// The ten finance agents (F0–F9) plus the accounts mailbox agent: what each
// one does, when it runs (scripts/schedule.cron.example) and what it is
// allowed to write. The agent definitions live in agents/*.md.
export const FINANCE_AGENTS = [
  { code: "F0", agent: "finance-f0-orchestration", name: "Orchestration & reporting", does: "06:45 health check and routing across F1–F9; 18:00 money report to the briefs channel; Friday pack; month and quarter-end chain; quarter-end \"ready for VAT\" draft to the accountant.", schedule: "Mon–Fri 06:45 · 18:00 · Fri 17:30", writes: "Read-only — posts briefs, drafts accounts emails" },
  { code: "F1", agent: "finance-f1-supplier-intake", name: "Supplier intake", does: "Owns the intake mailboxes: validates each extracted invoice, dedupes across inboxes, marks ready or held, routes statements to F7 and pro-formas to F5, drafts missing-invoice requests.", schedule: "07:00 · 12:00 · 16:00", writes: "Hold / release intake items, drafts only" },
  { code: "F8", agent: "finance-f8-bill-coding-posting", name: "Bill coding & posting", does: "Codes ready invoices (account from the supplier profile and line text, class from the project or client name, VAT by ratio, due date from terms), posts the Bill with its PDF to QuickBooks, verifies against supplier balances, holds low confidence.", schedule: "07:20 · 12:20 · 16:20", writes: "Posts bills to QuickBooks — in manual autopilot nothing posts without a human" },
  { code: "F2", agent: "finance-f2-bank-ledger", name: "Bank & ledger", does: "Prepares every bank-feed match so it is a tick, not a decision: supplier payments to the creditor account allocated oldest-first, customer receipts on account, interbank transfers as transfers, fees as separate lines. Proposes QuickBooks bank rules from history.", schedule: "08:00 · month-end WD1 bank rec", writes: "record_payment only after the owner confirms the receipt in the run" },
  { code: "F3", agent: "finance-f3-customer-receipts", name: "Customer invoices & receipts", does: "Stages deposit, survey and delivery invoices for due schedule lines, checks debtors and class coding, enforces the builder certificate on zero-rated work, prepares the final-invoice pack for the approvers.", schedule: "08:30 · month-end WD1", writes: "raise_invoice (stage invoices). The final QuickBooks invoice is human-only" },
  { code: "F4", agent: "finance-f4-cashflow", name: "Cashflow", does: "Daily cash sheet: opening bank, confirmed receipts, supplier outflows coloured by the playbook, loans, direct debits, payroll and VAT, and the Friday available-to-pay figure for F5.", schedule: "09:00 · Thu 16:00 · Fri 08:00", writes: "append_cashflow_entry — provisional, cannot authorise payments" },
  { code: "F5", agent: "finance-f5-payment-proposals", name: "Payment proposals", does: "Thursday ranked payment table from the supplier playbook ladder, Friday refresh, remittance drafts after release. Disputed and unposted items excluded.", schedule: "Thu 17:00 · Fri 08:30 · Fri 14:00", writes: "Proposals and remittance drafts only — the owner releases payments" },
  { code: "F7", agent: "finance-f7-reconciliation", name: "Reconciliation & disputes", does: "Reconciles supplier statements to QuickBooks, raises and updates the dispute register with evidence, keeps the supplier playbook, drafts query and holding emails from the accounts mailbox.", schedule: "Mon 10:00 · 1st of month", writes: "Disputes, supplier profiles, drafts" },
  { code: "F6", agent: "finance-f6-pnl-commission", name: "P&L & commission", does: "Monthly P&L by class per delivered project (QuickBooks), salesperson commission tiers and payable split, year-on-year totals; reports to F9 and an approval task to the owner.", schedule: "WD2 10:00", writes: "Read-only — never changes ledger data" },
  { code: "F9", agent: "finance-f9-reports-keeper", name: "Reports keeper", does: "Refreshes the finance reports from the store twice daily, reads back and verifies totals, records released payments on Fridays, refreshes month-end tabs.", schedule: "09:30 · 17:30 · Fri 15:00", writes: "Report data only — never the source of truth" },
  { code: "A", agent: "accounts-email-agent", name: "Accounts mailbox agent", does: "Triages the accounts mailbox: supplier invoices, statements, payment chases, remittances, credit notes, customer payment questions; drafts factual replies from QuickBooks and project figures.", schedule: "10:00 · 14:00 · 17:30", writes: "Drafts only — nothing is sent, nothing is paid" },
] as const;

export function FinanceAgentsRoster() {
  const { channelName, timezone } = useCompany();
  const { data, error, loading, reload } = useApi<BriefsResponse>("/api/finance/briefs?limit=12");
  const [open, setOpen] = React.useState<string | null>(null);
  const briefs = data?.briefs || null;
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10"><Bot className="h-5 w-5 text-primary" /></div>
            <div>
              <h3 className="text-sm font-semibold">The finance agents</h3>
              <p className="text-[11px] text-muted-foreground">Mon–Fri on your schedule ({timezone}), briefs to #{channelName}. Humans keep every release: the owner releases payments, a human raises the final QuickBooks invoice, nothing posts to QuickBooks in manual mode without a click.</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> Drafts and proposals only · no payments · no final invoices</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className={THEAD}><tr><TH className="w-10">Agent</TH><TH>Role</TH><TH>Runs</TH><TH>May write</TH></tr></thead>
            <tbody>
              {FINANCE_AGENTS.map((a) => (
                <tr key={a.code} className="cursor-pointer border-b border-border/40 align-top hover:bg-muted/30" onClick={() => setOpen(open === a.code ? null : a.code)}>
                  <td className="p-2"><Badge className="border-0 bg-primary/10 font-semibold tabular-nums text-primary">{a.code}</Badge></td>
                  <td className="p-2"><p className="font-medium">{a.name} <span className="font-mono text-[10px] font-normal text-muted-foreground">{a.agent}</span></p><p className={cn("text-xs text-muted-foreground", open !== a.code && "line-clamp-1")}>{a.does}</p></td>
                  <td className="whitespace-nowrap p-2 text-xs text-muted-foreground"><Clock className="mr-1 inline h-3 w-3" />{a.schedule}</td>
                  <td className="p-2 text-xs text-muted-foreground">{a.writes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">Install: copy <code>agents/*.md</code> to <code>~/.claude/agents/</code>, add the MCP server from Setup ▸ Agents, then run <code>scripts/run-agent.sh &lt;agent&gt;</code> from cron (see <code>scripts/schedule.cron.example</code>).</p>
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold"><MessageSquare className="h-4 w-4 text-primary" /> Latest briefs — #{channelName}</h3>
            <p className="text-[11px] text-muted-foreground">The agents&apos; run summaries and the owner replies that approve or reject new suppliers.</p>
          </div>
          <div className="flex items-center gap-1.5">
            <RefreshButton onClick={reload} loading={loading} />
            <Link href="/briefs" className="inline-flex items-center gap-1 text-xs text-primary hover:underline"><ExternalLink className="h-3 w-3" /> Open channel</Link>
          </div>
        </div>
        {error ? <ErrorNote>Briefs unavailable: {error}</ErrorNote> : null}
        {briefs && briefs.length === 0 ? <Empty icon={MessageSquare}>No briefs yet. The agents post here after each run; you can reply from the Briefs page.</Empty> : null}
        {briefs && briefs.length > 0 ? (
          <div className="space-y-2">
            {briefs.map((m) => (
              <details key={m.id} className="rounded-lg border border-border/60 bg-muted/20 p-2.5 text-sm">
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-medium">{m.author}</span>
                  {m.authorKind === "agent" ? <Badge className="border-0 bg-primary/10 text-[10px] text-primary">agent</Badge> : null}
                  <span className="text-[11px] text-muted-foreground">{ago(m.createdAt)}</span>
                  <span className="basis-full truncate text-xs text-muted-foreground">{m.text.split("\n")[0].slice(0, 160)}</span>
                </summary>
                <pre className="mt-2 whitespace-pre-wrap font-sans text-xs text-foreground/90">{m.text}</pre>
              </details>
            ))}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
