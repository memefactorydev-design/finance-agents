"use client";

import * as React from "react";
import { AlertTriangle, RefreshCw, Inbox } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Shared building blocks for the finance views: a titled card, a stat tile,
// empty / error states and a refresh button.
export function Section({ id, title, hint, icon: Icon, actions, children, className }: { id?: string; title: React.ReactNode; hint?: React.ReactNode; icon?: React.ComponentType<{ className?: string }>; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <Card id={id} className={cn("p-4", className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {Icon ? <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10"><Icon className="h-5 w-5 text-primary" /></div> : null}
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{title}</h3>
            {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
          </div>
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
      {children}
    </Card>
  );
}

export function Stat({ label, value, sub, tone = "default", className }: { label: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode; tone?: "default" | "money" | "good" | "bad" | "muted"; className?: string }) {
  return (
    <div className={cn("rounded-lg bg-muted/40 p-3", className)}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("font-display text-lg font-bold leading-tight tabular-nums", tone === "money" && "text-money", tone === "good" && "text-green-600 dark:text-green-400", tone === "bad" && "text-red-500", tone === "muted" && "text-muted-foreground")}>{value}</p>
      {sub ? <p className="text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

export function Empty({ children, icon: Icon = Inbox }: { children: React.ReactNode; icon?: React.ComponentType<{ className?: string }> }) {
  return <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground"><Icon className="h-6 w-6 opacity-60" /><p>{children}</p></div>;
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-300"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{children}</span></p>;
}

export function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warn" | "good" }) {
  return (
    <div className={cn("mb-3 rounded-lg border p-2.5 text-xs", tone === "warn" && "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300", tone === "good" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300", tone === "info" && "border-primary/30 bg-primary/5 text-foreground")}>{children}</div>
  );
}

export function RefreshButton({ onClick, loading, label = "Refresh", title }: { onClick: () => void; loading?: boolean; label?: string; title?: string }) {
  return <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={onClick} disabled={loading} title={title}><RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} /> {label}</Button>;
}

// Pill-style filter buttons (state tabs inside a view).
export function Pills<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { key: T; label: React.ReactNode }[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((s) => (
        <button key={s.key} type="button" onClick={() => onChange(s.key)} className={cn("h-7 rounded-full border px-2.5 text-xs transition-colors", value === s.key ? "border-foreground bg-foreground text-background" : "border-border/60 hover:bg-muted/40")}>{s.label}</button>
      ))}
    </div>
  );
}

export const TH = ({ children, className, right }: { children?: React.ReactNode; className?: string; right?: boolean }) => <th className={cn("p-2 text-left font-medium", right && "text-right", className)}>{children}</th>;
export const THEAD = "border-b border-border/60 text-[11px] uppercase tracking-wide text-muted-foreground";
export const select = "h-7 w-full rounded border border-border/60 bg-background px-1.5 text-xs";
export const field = "h-8 w-full rounded-md border border-input bg-background px-2 text-xs";
export const label = "text-[10px] uppercase tracking-wide text-muted-foreground";
