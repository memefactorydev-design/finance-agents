"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { useMoney } from "@/components/use-api";
import { cn } from "@/lib/utils";

// Money input that commits on blur / Enter (never on every keystroke — money
// edits write to the server). Shows the stored value formatted while idle.
export function MoneyField({ value, onCommit, disabled, placeholder = "0.00", className, inputClassName, size = "md", title }: {
  value: number | null | undefined;
  onCommit: (value: number | null) => void | Promise<unknown>;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  size?: "sm" | "md";
  title?: string;
}) {
  const { symbol } = useMoney();
  const stored = value == null ? "" : String(Math.round(value * 100) / 100);
  const [draft, setDraft] = React.useState(stored);
  const [focused, setFocused] = React.useState(false);
  React.useEffect(() => { if (!focused) setDraft(stored); }, [stored, focused]);

  const commit = () => {
    setFocused(false);
    if (draft === stored) return;
    if (draft.trim() === "") { onCommit(null); return; }
    const n = parseFloat(draft.replace(/[£$€,\s]/g, ""));
    if (Number.isNaN(n) || n < 0) { setDraft(stored); return; }
    onCommit(Math.round(n * 100) / 100);
  };

  return (
    <div className={cn("relative", className)} title={title}>
      <span className={cn("pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground", size === "sm" ? "text-xs" : "text-sm")}>{symbol}</span>
      <Input
        type="text"
        inputMode="decimal"
        disabled={disabled}
        placeholder={placeholder}
        value={focused ? draft : stored ? Number(stored).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ""}
        onFocus={() => { setFocused(true); setDraft(stored); }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") { setDraft(stored); (e.target as HTMLInputElement).blur(); }
        }}
        className={cn("pl-6 font-medium tabular-nums", size === "sm" ? "h-8 text-xs" : "h-9 text-sm", disabled && "bg-muted/40", inputClassName)}
      />
    </div>
  );
}
