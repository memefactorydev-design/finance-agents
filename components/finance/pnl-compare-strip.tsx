"use client";

import * as React from "react";
import { Lock, Activity, ArrowRight, AlertTriangle, Truck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMoney } from "@/components/use-api";
import type { Pnl, PnlComparison, PnlStage, PnlDelta } from "./types";

const STAGE_LABEL: Record<PnlStage, string> = { sales: "Sales P&L", order: "Order P&L", supplier: "Supplier P&L", completion: "Completion P&L" };
const STAGE_HINT: Record<PnlStage, string> = {
  sales: "Costing at the point of sale",
  order: "Order costing (what was ordered from suppliers)",
  supplier: "Supplier-acknowledged prices incl. carriage and surcharges; ordered prices where not yet acknowledged",
  completion: "What the suppliers actually invoiced — QuickBooks bills, credits and purchases on the project's class — plus manual extras. Shown once every supplier on the project has invoiced.",
};

function PnlTile({ pnl, delta, vsLabel, extraLine, compact }: { pnl: Pnl; delta?: PnlDelta | null; vsLabel?: string; extraLine?: React.ReactNode; compact?: boolean }) {
  const { money } = useMoney();
  const good = pnl.profit >= 0;
  const title = [STAGE_HINT[pnl.stage], ...(pnl.warnings || [])].join("\n");
  return (
    <div className={cn("min-w-0 rounded-lg bg-muted/30 p-3", !pnl.available && "opacity-70")} title={title}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{STAGE_LABEL[pnl.stage]}</p>
        <span className={cn("flex items-center gap-0.5 text-[10px]", pnl.frozen ? "text-muted-foreground" : "text-sky-600")}>
          {pnl.frozen ? <Lock className="h-3 w-3" /> : <Activity className="h-3 w-3" />}
          {pnl.frozen ? (pnl.capturedAt ? new Date(pnl.capturedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "frozen") : pnl.available ? "live" : "—"}
        </span>
      </div>
      {pnl.available ? (
        <>
          <p className={cn("font-display font-bold leading-tight tabular-nums", compact ? "text-lg" : "text-xl", good ? "text-green-600 dark:text-green-400" : "text-red-500")}>{money(pnl.profit)}</p>
          <p className="text-[11px] text-muted-foreground">{pnl.marginPct}% margin · cost {money(pnl.cost)}{pnl.addonSell > 0 ? ` · add-ons +${money(pnl.addonSell)}` : ""}</p>
          {delta ? (
            <p className={cn("mt-1 flex items-center gap-1 text-[11px]", delta.profit >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500")}>
              <ArrowRight className="h-3 w-3" /> {delta.profit >= 0 ? "+" : ""}{money(delta.profit)} {vsLabel || "vs previous"} ({delta.marginPts >= 0 ? "+" : ""}{delta.marginPts} pts)
            </p>
          ) : null}
          {extraLine}
          {pnl.source && !compact ? <p className="truncate text-[10px] text-muted-foreground">{pnl.source}</p> : null}
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{pnl.stage === "completion" && pnl.source ? pnl.source : "Not captured yet"}</p>
          {pnl.stage === "completion" && pnl.cost > 0 ? <p className="mt-0.5 text-[11px] text-muted-foreground">{money(pnl.cost)} invoiced so far</p> : null}
        </>
      )}
    </div>
  );
}

// Sales → Order → Supplier → Completion side by side, with deltas, supplier
// drift (acknowledged vs ordered) and the extra spend between order and completion.
export function PnlCompareStrip({ comparison, compact = false, className }: { comparison: PnlComparison; compact?: boolean; className?: string }) {
  const { money } = useMoney();
  const { sales, order, supplier, completion, deltas, extraSpend, postCompletion, supplierDrift: drift } = comparison;
  return (
    <div className={cn("space-y-2", className)}>
      <div className={cn("grid gap-2", compact ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4")}>
        <PnlTile pnl={sales} compact={compact} />
        <PnlTile pnl={order} delta={deltas.salesToOrder} vsLabel="vs sales" compact={compact} />
        <PnlTile pnl={supplier} delta={deltas.orderToSupplier} vsLabel="vs order" compact={compact}
          extraLine={drift ? (
            <p className={cn("mt-1 flex items-center gap-1 text-[11px]", drift.delta > 0 ? "text-amber-600" : "text-muted-foreground")}>
              <Truck className="h-3 w-3" /> Suppliers {drift.delta >= 0 ? "+" : "−"}{money(Math.abs(drift.delta))} vs ordered · {drift.acknowledgedOrders} of {drift.totalOrders} acknowledged{drift.extras ? ` · extras ${money(drift.extras)}` : ""}
            </p>
          ) : supplier.available ? (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground"><Truck className="h-3 w-3" /> No acknowledgements yet — ordered prices</p>
          ) : null} />
        <PnlTile pnl={completion} delta={deltas.orderToCompletion} vsLabel="vs order" compact={compact} />
      </div>
      {extraSpend.total > 0 || postCompletion ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11px] text-muted-foreground">
          {extraSpend.remedial > 0 ? <span>Remedials <span className="font-medium text-orange-600">{money(extraSpend.remedial)}</span></span> : null}
          {extraSpend.extra > 0 ? <span>Extra costs <span className="font-medium text-orange-600">{money(extraSpend.extra)}</span></span> : null}
          {extraSpend.addonCost > 0 ? <span>Add-on cost {money(extraSpend.addonCost)} / sell {money(extraSpend.addonSell)}</span> : null}
          {postCompletion ? <span className="flex items-center gap-1 text-amber-600"><AlertTriangle className="h-3 w-3" /> {money(postCompletion.cost + postCompletion.extraCost)} spent after Stage 2 sign-off (not in Completion P&L)</span> : null}
        </div>
      ) : null}
    </div>
  );
}
