"use client";

import * as React from "react";
import Link from "next/link";
import { Link2, ShieldCheck, Settings } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api } from "@/components/use-api";
import { pretty, fmtWhen } from "./money";
import type { QuickBooksStatus } from "./types";

// Connection card at the top of Finance Agents. "Connected" is only claimed
// after a real QuickBooks read succeeded (lib/qbo/status). Posting stays a
// dry run until the switch in Setup ▸ QuickBooks is on.
export function QuickBooksCard({ quickbooks, onChanged }: { quickbooks: QuickBooksStatus | null; onChanged?: () => void }) {
  const [busy, setBusy] = React.useState(false);
  if (!quickbooks) return <Card className="p-4 text-sm text-muted-foreground">Checking the QuickBooks connection…</Card>;
  const q = quickbooks;
  const tone = q.connected ? "green" : q.configured ? "amber" : "muted";
  const text = q.connected
    ? `Connected to ${q.companyName || `company ${q.realm}`} (${q.environment}, ${q.mode === "composio" ? "via Composio" : "your Intuit app"}). ${q.posting ? "Posting is ON: approved bills are written to QuickBooks." : "Posting is OFF: every write is a dry run that stores the exact payload."}`
    : !q.configured
      ? "QuickBooks is not configured yet. Add your Intuit app or Composio details in Setup."
      : q.tokenStatus === "outcome_unknown" || q.tokenStatus === "refreshing" || q.error === "QBO_REFRESH_IN_PROGRESS"
        ? `QuickBooks did not answer the last token refresh — the app retries automatically${q.recovery ? ` (attempt ${q.recovery.attempts}${q.recovery.lastError ? `, last error ${q.recovery.lastError}` : ""})` : ""}. Reconnect only if it stays down.`
        : q.tokenStatus === "reauth_required"
          ? `QuickBooks rejected the stored token${q.recovery?.lastError ? ` (${q.recovery.lastError})` : ""} — reconnect to continue.`
          : q.tokenStatus
            ? `Token ${pretty(q.tokenStatus)}${q.error ? ` · ${q.error}` : ""} — reconnect to continue.`
            : `Not connected yet (${q.environment}). The first consent binds the QuickBooks company.`;
  const disconnect = async () => {
    if (!window.confirm("Disconnect QuickBooks? Reads and posting stop until you reconnect.")) return;
    setBusy(true);
    try { await api("/api/oauth/qbo/disconnect", { method: "POST", json: {} }); toast.success("QuickBooks disconnected"); onChanged?.(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Disconnect failed"); } finally { setBusy(false); }
  };
  return (
    <Card className={cn("p-4", q.connected && "border-green-500/30")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", tone === "green" ? "bg-green-500/15" : tone === "amber" ? "bg-amber-500/15" : "bg-muted")}><Link2 className={cn("h-5 w-5", tone === "green" ? "text-green-600" : tone === "amber" ? "text-amber-600" : "text-muted-foreground")} /></div>
          <div className="min-w-0">
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">QuickBooks Online <Badge className={cn("border-0 text-[10px]", q.posting ? "bg-green-500/15 text-green-700 dark:text-green-400" : "bg-amber-500/15 text-amber-700 dark:text-amber-400")}>{q.posting ? "posting on" : "dry run"}</Badge></h3>
            <p className="text-xs text-muted-foreground">{text}</p>
            {q.connected && q.recovery?.recoveredAt ? <p className="mt-1 text-[11px] text-muted-foreground">Self-healed {fmtWhen(q.recovery.recoveredAt)} after a lost refresh.</p> : null}
            {q.realm && !q.connected ? <p className="mt-1 text-[11px] text-muted-foreground">Bound company: {q.realm}</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {q.configured && q.mode === "oauth" ? (
            <Button asChild size="sm" className="gap-1.5" variant={q.connected ? "outline" : "default"}><a href="/api/oauth/qbo/connect"><ShieldCheck className="h-4 w-4" /> {q.connected ? "Reconnect" : "Connect QuickBooks"}</a></Button>
          ) : null}
          {q.configured && q.mode === "oauth" && q.tokenStatus && q.tokenStatus !== "disconnected" ? <Button size="sm" variant="outline" onClick={disconnect} disabled={busy}>Disconnect</Button> : null}
          <Button asChild size="sm" variant="ghost" className="gap-1.5"><Link href="/setup?step=quickbooks"><Settings className="h-4 w-4" /> Setup</Link></Button>
        </div>
      </div>
    </Card>
  );
}
