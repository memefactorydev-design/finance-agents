"use client";

// Form primitives shared by the setup steps: labelled fields with an
// "set by environment" badge, secret inputs that leave a stored secret
// untouched unless retyped, list inputs, toggles, copy boxes, the test
// button and the save bar. Also the step contract every step implements.
import * as React from "react";
import { Eye, EyeOff, Copy, Check, FlaskConical, Save, ArrowRight, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api, copyText, type SessionUser } from "@/components/use-api";
import type { Connections } from "@/lib/core/config";
import type { SetupState } from "@/lib/core/setup";

export type { Connections, SetupState };
export interface SetupResponse { state: SetupState; connections: Connections | null; user: SessionUser | null }
export interface StepProps { state: SetupState; connections: Connections; user: SessionUser | null; reload: () => Promise<void>; next: () => void }

export const isMasked = (v: string | null | undefined) => !!v && /^••••/.test(v);
export const origin = () => (typeof window !== "undefined" ? window.location.origin : "");

// Save one wizard step. Masked secrets ("••••abcd") are stripped server-side,
// so an untouched secret field is never overwritten.
export async function saveStep(step: string, connections: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return api<{ ok: true; connections: Connections; state: SetupState }>("/api/setup", { method: "POST", json: { connections, step, ...extra } });
}

export function useDraft<T>(initial: T, deps: unknown[]) {
  const [draft, setDraft] = React.useState<T>(initial);
  const [dirty, setDirty] = React.useState(false);
  React.useEffect(() => { setDraft(initial); setDirty(false); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  const set = React.useCallback(<K extends keyof T>(k: K, v: T[K]) => { setDraft((d) => ({ ...d, [k]: v })); setDirty(true); }, []);
  const patch = React.useCallback((p: Partial<T>) => { setDraft((d) => ({ ...d, ...p })); setDirty(true); }, []);
  return { draft, set, patch, dirty, setDirty };
}

const EnvContext = React.createContext<string[]>([]);
export const EnvProvider = EnvContext.Provider;
export function useEnvSet(name?: string | string[]) {
  const env = React.useContext(EnvContext);
  if (!name) return null;
  const names = Array.isArray(name) ? name : [name];
  return names.find((n) => env.includes(n)) || null;
}

export function EnvBadge({ name }: { name: string }) {
  return <Badge variant="secondary" className="gap-1 font-mono text-[10px]" title={`${name} is set in the environment and overrides this value`}><Lock className="h-2.5 w-2.5" /> {name}</Badge>;
}

export function Field({ label, hint, env, children, className }: { label: React.ReactNode; hint?: React.ReactNode; env?: string | string[]; children: React.ReactNode; className?: string }) {
  const set = useEnvSet(env);
  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex flex-wrap items-center gap-2"><p className="text-xs font-medium">{label}</p>{set ? <EnvBadge name={set} /> : null}</div>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function TextField({ label, hint, env, value, onChange, type = "text", placeholder, mono, required, className }: { label: React.ReactNode; hint?: React.ReactNode; env?: string | string[]; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; mono?: boolean; required?: boolean; className?: string }) {
  const set = useEnvSet(env);
  return <Field label={label} hint={hint} env={env} className={className}><Input type={type} className={cn("h-9", mono && "font-mono text-xs")} value={value} placeholder={placeholder} required={required} disabled={!!set} onChange={(e) => onChange(e.target.value)} /></Field>;
}

export function NumberField({ label, hint, env, value, onChange, min, max, step, className }: { label: React.ReactNode; hint?: React.ReactNode; env?: string; value: number | string; onChange: (v: string) => void; min?: number; max?: number; step?: number; className?: string }) {
  const set = useEnvSet(env);
  return <Field label={label} hint={hint} env={env} className={className}><Input type="number" inputMode="decimal" className="h-9" value={value} min={min} max={max} step={step} disabled={!!set} onChange={(e) => onChange(e.target.value)} /></Field>;
}

// A stored secret arrives masked ("••••abcd"). Leaving it alone keeps the
// stored value; typing replaces it. The eye toggle only reveals what you type.
export function SecretField({ label, hint, env, value, onChange, placeholder, className }: { label: React.ReactNode; hint?: React.ReactNode; env?: string | string[]; value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const set = useEnvSet(env);
  const [show, setShow] = React.useState(false);
  const masked = isMasked(value);
  return (
    <Field label={label} hint={hint} env={env} className={className}>
      <div className="relative">
        <Input type={show && !masked ? "text" : "password"} className="h-9 pr-20 font-mono text-xs" value={masked ? "" : value} placeholder={masked ? `${value} (stored — type to replace)` : placeholder || "not set"} disabled={!!set} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
          {masked && !set ? <Badge variant="secondary" className="text-[9px]">stored</Badge> : null}
          {!masked ? <button type="button" className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label={show ? "Hide" : "Show"} onClick={() => setShow((s) => !s)}>{show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</button> : null}
        </div>
      </div>
    </Field>
  );
}

// Comma / newline separated → string[] (shown one per line).
export function ListField({ label, hint, env, value, onChange, placeholder, rows = 3, lower = true, className }: { label: React.ReactNode; hint?: React.ReactNode; env?: string; value: string[]; onChange: (v: string[]) => void; placeholder?: string; rows?: number; lower?: boolean; className?: string }) {
  const set = useEnvSet(env);
  const [text, setText] = React.useState(value.join("\n"));
  const joined = value.join("\n");
  React.useEffect(() => { setText(joined); }, [joined]);
  const commit = () => onChange(Array.from(new Set(text.split(/[,\n;]+/).map((s) => (lower ? s.trim().toLowerCase() : s.trim())).filter(Boolean))));
  return <Field label={label} hint={hint} env={env} className={className}><Textarea className="min-h-0 font-mono text-xs" rows={rows} value={text} placeholder={placeholder} disabled={!!set} onChange={(e) => setText(e.target.value)} onBlur={commit} /></Field>;
}

export function ToggleField({ label, hint, env, checked, onChange, className }: { label: React.ReactNode; hint?: React.ReactNode; env?: string; checked: boolean; onChange: (v: boolean) => void; className?: string }) {
  const set = useEnvSet(env);
  return (
    <label className={cn("flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 p-3", className)}>
      <Switch checked={checked} onCheckedChange={onChange} disabled={!!set} className="mt-0.5" />
      <span className="min-w-0"><span className="flex flex-wrap items-center gap-2 text-xs font-medium">{label}{set ? <EnvBadge name={set} /> : null}</span>{hint ? <span className="block text-[11px] text-muted-foreground">{hint}</span> : null}</span>
    </label>
  );
}

export function SelectField<T extends string>({ label, hint, env, value, onChange, options, className }: { label: React.ReactNode; hint?: React.ReactNode; env?: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string }) {
  const set = useEnvSet(env);
  return <Field label={label} hint={hint} env={env} className={className}><select className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm" value={value} disabled={!!set} onChange={(e) => onChange(e.target.value as T)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>;
}

export function Choice<T extends string>({ value, onChange, options, env }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; hint?: string }[]; env?: string }) {
  const set = useEnvSet(env);
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {options.map((o) => (
        <button key={o.value} type="button" disabled={!!set} onClick={() => onChange(o.value)} aria-pressed={value === o.value} className={cn("rounded-lg border p-3 text-left transition-colors", value === o.value ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border/60 hover:bg-muted/40", set && "cursor-default opacity-70")}>
          <p className="text-sm font-medium">{o.label}</p>{o.hint ? <p className="text-[11px] text-muted-foreground">{o.hint}</p> : null}
        </button>
      ))}
      {set ? <p className="text-[11px] text-muted-foreground sm:col-span-2 lg:col-span-3">Chosen by <EnvBadge name={set} /></p> : null}
    </div>
  );
}

export function CopyBox({ value, label, mono = true }: { value: string; label?: React.ReactNode; mono?: boolean }) {
  const [done, setDone] = React.useState(false);
  const copy = async () => { if (await copyText(value)) { setDone(true); toast.success("Copied"); setTimeout(() => setDone(false), 1500); } };
  return (
    <div className="space-y-1">
      {label ? <p className="text-xs font-medium">{label}</p> : null}
      <div className="flex items-stretch gap-1">
        <pre className={cn("min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 px-3 py-2 text-xs", mono && "font-mono")}>{value}</pre>
        <Button type="button" variant="outline" size="icon" className="h-auto shrink-0" aria-label="Copy" onClick={copy}>{done ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}</Button>
      </div>
    </div>
  );
}

export type TestWhat = "quickbooks" | "mail" | "crm" | "ai";
export function TestButton({ what, label = "Test connection", onResult, disabled }: { what: TestWhat; label?: string; onResult: (r: Record<string, unknown>) => void; disabled?: boolean }) {
  const [busy, setBusy] = React.useState(false);
  const run = async () => {
    setBusy(true);
    try { const r = await api<Record<string, unknown>>("/api/setup/test", { method: "POST", json: { what } }); onResult(r); toast[r.ok ? "success" : "error"](r.ok ? "Connection ok" : `Test failed${r.error ? `: ${String(r.error)}` : ""}`); }
    catch (e) { onResult({ ok: false, error: e instanceof Error ? e.message : "Failed" }); toast.error(e instanceof Error ? e.message : "Test failed"); }
    finally { setBusy(false); }
  };
  return <Button type="button" variant="outline" className="gap-1.5" onClick={run} disabled={busy || disabled}><FlaskConical className={cn("h-4 w-4", busy && "animate-pulse")} /> {busy ? "Testing…" : label}</Button>;
}

export function TestResult({ result }: { result: Record<string, unknown> | null }) {
  if (!result) return null;
  const ok = !!result.ok;
  return (
    <div className={cn("rounded-lg border p-3 text-xs", ok ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5")}>
      <p className={cn("mb-1 font-medium", ok ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-300")}>{ok ? "Test passed" : "Test failed"}{result.error ? ` — ${String(result.error)}` : ""}{result.note ? ` — ${String(result.note)}` : ""}</p>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">{JSON.stringify(result, null, 2)}</pre>
    </div>
  );
}

export function SaveBar({ onSave, saving, dirty, onNext, saveLabel = "Save", nextLabel = "Continue", children }: { onSave: () => void; saving: boolean; dirty: boolean; onNext?: () => void; saveLabel?: string; nextLabel?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-4">
      {children}
      <div className="ml-auto flex gap-2">
        <Button type="button" onClick={onSave} disabled={saving} className="gap-1.5" variant={dirty ? "default" : "outline"}><Save className="h-4 w-4" /> {saving ? "Saving…" : saveLabel}</Button>
        {onNext ? <Button type="button" variant={dirty ? "outline" : "default"} className="gap-1.5" onClick={onNext}>{nextLabel} <ArrowRight className="h-4 w-4" /></Button> : null}
      </div>
    </div>
  );
}

export function StepHeader({ title, intro }: { title: string; intro: React.ReactNode }) {
  return <div className="mb-4"><h2 className="font-display text-lg font-bold">{title}</h2><p className="text-sm text-muted-foreground">{intro}</p></div>;
}

export const Grid = ({ children, cols = 2 }: { children: React.ReactNode; cols?: 2 | 3 }) => <div className={cn("grid gap-4", cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>{children}</div>;
