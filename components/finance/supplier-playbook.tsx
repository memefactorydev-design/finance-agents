"use client";

import * as React from "react";
import { BookOpen, Plus, Sparkles, X, Save, AlertTriangle, CalendarClock, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api, ApiError, useApi, useMoney } from "@/components/use-api";
import { Section, ErrorNote, RefreshButton, Empty, TH, THEAD, field, label } from "./section";
import { fmtDay } from "./money";
import type { Commitment, CommitmentsResponse, SupplierProfile, SupplierRow, SuppliersResponse } from "./types";

// Supplier playbook — the supplier knowledge the agents run on, as data:
// terms, statement accounts, block/safe days, who takes a card, who is on
// hold, default QuickBooks category, auto-post. F5 ranks the Friday run from
// it, F8 codes from it, F7 keeps it. Plus the standing commitments (loans,
// overheads, payroll, tax, cards) the cashflow outlook includes.
type Pressure = SupplierProfile["pressure"];
type PaymentMethod = SupplierProfile["paymentMethods"][number];
type TermsKind = NonNullable<SupplierProfile["terms"]>["kind"];
const PRESSURES: Pressure[] = ["low", "medium", "high", "critical"];
const METHODS: PaymentMethod[] = ["bacs", "card", "amex", "paypal"];
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const termsLabel = (t: SupplierProfile["terms"]) => (!t ? "—" : t.kind === "eom_next" ? "End of next month" : `Net ${t.days}`);
const pressureTone: Record<Pressure, string> = { low: "bg-emerald-500/15 text-emerald-600", medium: "bg-muted text-muted-foreground", high: "bg-amber-500/15 text-amber-600", critical: "bg-red-500/15 text-red-500" };

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return <label className="flex cursor-pointer select-none items-center gap-2 text-xs"><input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={checked} onChange={(e) => onChange(e.target.checked)} />{children}</label>;
}

type Draft = {
  vendorId: string; vendorName: string; termsKind: TermsKind | "none"; termsDays: string; statementAccount: boolean;
  blockAfterDaysOverdue: string; safeDaysOverdue: string; pressure: Pressure; onHold: boolean; proformaOnly: boolean;
  paymentMethods: PaymentMethod[]; paymentLinkWording: string; allocateOldestFirst: boolean; defaultAccountName: string;
  autoPost: boolean; creditLimit: string; aliases: string; emailDomains: string; contacts: string; notes: string;
};
const toDraft = (p: Partial<SupplierProfile> & { vendorId: string }): Draft => ({
  vendorId: p.vendorId, vendorName: p.vendorName || "",
  termsKind: p.terms ? p.terms.kind : "none", termsDays: p.terms?.kind === "days" ? String(p.terms.days) : "30",
  statementAccount: !!p.statementAccount, blockAfterDaysOverdue: p.blockAfterDaysOverdue != null ? String(p.blockAfterDaysOverdue) : "",
  safeDaysOverdue: p.safeDaysOverdue != null ? String(p.safeDaysOverdue) : "", pressure: p.pressure || "medium",
  onHold: !!p.onHold, proformaOnly: !!p.proformaOnly, paymentMethods: p.paymentMethods || ["bacs"], paymentLinkWording: p.paymentLinkWording || "",
  allocateOldestFirst: p.allocateOldestFirst ?? true, defaultAccountName: p.defaultAccountName || "", autoPost: !!p.autoPost,
  creditLimit: p.creditLimit != null ? String(p.creditLimit) : "", aliases: (p.aliases || []).join(", "), emailDomains: (p.emailDomains || []).join(", "),
  contacts: (p.contacts || []).map((c) => [c.name, c.email, c.phone, c.role].filter(Boolean).join(" | ")).join("\n"), notes: p.notes || "",
});
const fromDraft = (d: Draft) => {
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  const list = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  return {
    vendorName: d.vendorName.trim(),
    terms: d.termsKind === "none" ? null : d.termsKind === "eom_next" ? { kind: "eom_next" as const, days: 0 } : { kind: "days" as const, days: Number(d.termsDays) || 30 },
    statementAccount: d.statementAccount, blockAfterDaysOverdue: num(d.blockAfterDaysOverdue), safeDaysOverdue: num(d.safeDaysOverdue), pressure: d.pressure,
    onHold: d.onHold, proformaOnly: d.proformaOnly, paymentMethods: d.paymentMethods.length ? d.paymentMethods : ["bacs"], paymentLinkWording: d.paymentLinkWording.trim() || null,
    allocateOldestFirst: d.allocateOldestFirst, defaultAccountName: d.defaultAccountName.trim() || null, autoPost: d.autoPost, creditLimit: num(d.creditLimit),
    aliases: list(d.aliases), emailDomains: list(d.emailDomains).map((x) => x.toLowerCase().replace(/^@/, "")),
    contacts: d.contacts.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [name, email, phone, role] = l.split("|").map((x) => x.trim()); return { name: name || "", ...(email ? { email } : {}), ...(phone ? { phone } : {}), ...(role ? { role } : {}) }; }),
    notes: d.notes.trim(),
  };
};

function EditDrawer({ draft, isNew, onChange, onClose, onSaved }: { draft: Draft; isNew: boolean; onChange: (d: Draft) => void; onClose: () => void; onSaved: (p: SupplierProfile) => void }) {
  const { symbol } = useMoney();
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => onChange({ ...draft, [k]: v });
  const vendorId = isNew ? (draft.vendorId.trim() || `pending:${slugify(draft.vendorName)}`) : draft.vendorId;
  const save = async () => {
    setSaving(true); setError(null);
    try {
      if (!draft.vendorName.trim()) throw new Error("Supplier name is required");
      if (!/^(\d+|pending:[a-z0-9][a-z0-9-]*)$/.test(vendorId)) throw new Error("Vendor id must be a QuickBooks id or pending:<slug>");
      const d = await api<{ profile: SupplierProfile }>(`/api/finance/suppliers/${encodeURIComponent(vendorId)}`, { method: "PUT", json: fromDraft(draft) });
      onSaved(d.profile);
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); } finally { setSaving(false); }
  };
  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{isNew ? "New supplier profile" : draft.vendorName}</p>
          <p className="text-[11px] text-muted-foreground">Vendor id <span className="font-mono">{vendorId}</span>{vendorId.startsWith("pending:") ? " · not yet matched to a QuickBooks vendor (F7 or “Learn from QuickBooks” fixes this)" : ""}</p>
        </div>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="col-span-2"><p className={label}>Supplier name (as in QuickBooks)</p><input className={field} value={draft.vendorName} onChange={(e) => set("vendorName", e.target.value)} /></div>
        {isNew ? <div className="col-span-2"><p className={label}>Vendor id (blank = pending:&lt;slug&gt;)</p><input className={cn(field, "font-mono")} placeholder={`pending:${slugify(draft.vendorName) || "name"}`} value={draft.vendorId} onChange={(e) => set("vendorId", e.target.value)} /></div> : null}
        <div><p className={label}>Terms</p><select className={field} value={draft.termsKind} onChange={(e) => set("termsKind", e.target.value as Draft["termsKind"])}><option value="none">Unknown</option><option value="days">Net days</option><option value="eom_next">End of following month</option></select></div>
        <div><p className={label}>Days (Net)</p><input className={field} type="number" min={0} max={120} disabled={draft.termsKind !== "days"} value={draft.termsDays} onChange={(e) => set("termsDays", e.target.value)} /></div>
        <div><p className={label}>Blocks after (days overdue)</p><input className={field} type="number" min={0} placeholder="e.g. 13" value={draft.blockAfterDaysOverdue} onChange={(e) => set("blockAfterDaysOverdue", e.target.value)} /></div>
        <div><p className={label}>Safe for (days overdue)</p><input className={field} type="number" min={0} placeholder="e.g. 7" value={draft.safeDaysOverdue} onChange={(e) => set("safeDaysOverdue", e.target.value)} /></div>
        <div><p className={label}>Pressure</p><select className={field} value={draft.pressure} onChange={(e) => set("pressure", e.target.value as Pressure)}>{PRESSURES.map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
        <div><p className={label}>Default QuickBooks account</p><input className={field} placeholder="e.g. Materials / Installation…" value={draft.defaultAccountName} onChange={(e) => set("defaultAccountName", e.target.value)} /></div>
        <div><p className={label}>Credit limit {symbol}</p><input className={field} type="number" min={0} value={draft.creditLimit} onChange={(e) => set("creditLimit", e.target.value)} /></div>
        <div><p className={label}>Payment methods</p><div className="flex flex-wrap gap-2 pt-1">{METHODS.map((m) => <Check key={m} checked={draft.paymentMethods.includes(m)} onChange={(v) => set("paymentMethods", v ? [...draft.paymentMethods, m] : draft.paymentMethods.filter((x) => x !== m))}>{m.toUpperCase()}</Check>)}</div></div>
        <div className="col-span-2 flex flex-wrap gap-4 pt-1 md:col-span-4">
          <Check checked={draft.statementAccount} onChange={(v) => set("statementAccount", v)}>Statement account</Check>
          <Check checked={draft.onHold} onChange={(v) => set("onHold", v)}><span className={cn(draft.onHold && "font-medium text-red-500")}>On hold</span></Check>
          <Check checked={draft.proformaOnly} onChange={(v) => set("proformaOnly", v)}>Pro-forma only</Check>
          <Check checked={draft.allocateOldestFirst} onChange={(v) => set("allocateOldestFirst", v)}>Allocate oldest first</Check>
          <Check checked={draft.autoPost} onChange={(v) => set("autoPost", v)}><span className={cn(draft.autoPost && "font-medium text-emerald-600")}>Auto-post bills (F8 may post without review)</span></Check>
        </div>
        <div className="col-span-2"><p className={label}>Aliases (comma separated)</p><input className={field} value={draft.aliases} onChange={(e) => set("aliases", e.target.value)} /></div>
        <div className="col-span-2"><p className={label}>Email domains (comma separated)</p><input className={field} placeholder="supplier.example.com" value={draft.emailDomains} onChange={(e) => set("emailDomains", e.target.value)} /></div>
        <div className="col-span-2"><p className={label}>Contacts — one per line: name | email | phone | role</p><textarea className={cn(field, "h-20 py-1")} value={draft.contacts} onChange={(e) => set("contacts", e.target.value)} /></div>
        <div className="col-span-2"><p className={label}>Payment-link wording (card suppliers)</p><textarea className={cn(field, "h-20 py-1")} value={draft.paymentLinkWording} onChange={(e) => set("paymentLinkWording", e.target.value)} /></div>
        <div className="col-span-2 md:col-span-4"><p className={label}>Notes (why — statement date, email, call)</p><textarea className={cn(field, "h-24 py-1")} value={draft.notes} onChange={(e) => set("notes", e.target.value)} /></div>
      </div>
      {error ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button size="sm" className="h-7 gap-1 text-xs" onClick={save} disabled={saving}><Save className="h-3 w-3" /> {saving ? "Saving…" : "Save profile"}</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ commitments
type CommitmentDraft = { id?: string; name: string; kind: Commitment["kind"]; amount: string; frequency: Commitment["frequency"]; dueDay: string; nextDue: string; balance: string; endDate: string; notes: string; active: boolean };
const emptyCommitment: CommitmentDraft = { name: "", kind: "overhead", amount: "", frequency: "monthly", dueDay: "1", nextDue: "", balance: "", endDate: "", notes: "", active: true };
const KINDS: Commitment["kind"][] = ["loan", "overhead", "payroll", "tax", "card"];
const FREQS: Commitment["frequency"][] = ["weekly", "monthly", "quarterly", "once"];

function CommitmentsCard() {
  const { money } = useMoney();
  const { data, error, loading, reload } = useApi<CommitmentsResponse>("/api/finance/commitments?includeInactive=1");
  const [draft, setDraft] = React.useState<CommitmentDraft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const set = <K extends keyof CommitmentDraft>(k: K, v: CommitmentDraft[K]) => draft && setDraft({ ...draft, [k]: v });
  const edit = (c: Commitment) => setDraft({ id: c.id, name: c.name, kind: c.kind, amount: String(c.amount), frequency: c.frequency, dueDay: c.dueDay != null ? String(c.dueDay) : "", nextDue: c.nextDue || "", balance: c.balance != null ? String(c.balance) : "", endDate: c.endDate || "", notes: c.notes || "", active: c.active });
  const save = async () => {
    if (!draft) return;
    const amount = parseFloat(draft.amount);
    if (!draft.name.trim() || !Number.isFinite(amount) || amount < 0) { toast.error("Name and amount are required"); return; }
    setSaving(true);
    try {
      await api("/api/finance/commitments", { method: "POST", json: { id: draft.id, name: draft.name.trim(), kind: draft.kind, amount, frequency: draft.frequency, dueDay: draft.dueDay ? Number(draft.dueDay) : null, nextDue: draft.nextDue || null, balance: draft.balance ? Number(draft.balance) : null, endDate: draft.endDate || null, notes: draft.notes, active: draft.active } });
      toast.success("Commitment saved"); setDraft(null); await reload();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Save failed"); } finally { setSaving(false); }
  };
  const deactivate = async (c: Commitment) => {
    if (!window.confirm(`Stop including "${c.name}" in the cashflow?`)) return;
    try { await api("/api/finance/commitments", { method: "POST", json: { id: c.id, name: c.name, kind: c.kind, amount: c.amount, frequency: c.frequency, active: false } }); await reload(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Update failed"); }
  };
  const rows = data?.commitments || [];
  return (
    <Section icon={CalendarClock} title="Standing commitments" hint="Loans, overheads, payroll, tax and card repayments the cashflow outlook deducts each week. Amounts are what leaves the bank."
      actions={<><RefreshButton onClick={reload} loading={loading} /><Button size="sm" className="h-7 gap-1 text-xs" onClick={() => setDraft({ ...emptyCommitment })}><Plus className="h-3 w-3" /> New commitment</Button></>}>
      {error ? <ErrorNote>Commitments unavailable: {error}</ErrorNote> : null}
      {draft ? (
        <div className="mb-3 rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="col-span-2"><p className={label}>Name</p><input className={field} value={draft.name} onChange={(e) => set("name", e.target.value)} /></div>
            <div><p className={label}>Kind</p><select className={field} value={draft.kind} onChange={(e) => set("kind", e.target.value as Commitment["kind"])}>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select></div>
            <div><p className={label}>Frequency</p><select className={field} value={draft.frequency} onChange={(e) => set("frequency", e.target.value as Commitment["frequency"])}>{FREQS.map((k) => <option key={k} value={k}>{k}</option>)}</select></div>
            <div><p className={label}>Amount</p><input className={field} type="number" min={0} step="0.01" value={draft.amount} onChange={(e) => set("amount", e.target.value)} /></div>
            <div><p className={label}>{draft.frequency === "weekly" ? "Weekday (1 = Mon … 7 = Sun)" : "Day of month"}</p><input className={field} type="number" min={1} max={draft.frequency === "weekly" ? 7 : 31} value={draft.dueDay} onChange={(e) => set("dueDay", e.target.value)} disabled={draft.frequency === "once"} /></div>
            <div><p className={label}>{draft.frequency === "once" ? "Due on" : "First due (optional)"}</p><input className={field} type="date" value={draft.nextDue} onChange={(e) => set("nextDue", e.target.value)} /></div>
            <div><p className={label}>Balance remaining (loans)</p><input className={field} type="number" min={0} step="0.01" value={draft.balance} onChange={(e) => set("balance", e.target.value)} /></div>
            <div><p className={label}>Ends (optional)</p><input className={field} type="date" value={draft.endDate} onChange={(e) => set("endDate", e.target.value)} /></div>
            <div className="col-span-2 md:col-span-3"><p className={label}>Notes</p><input className={field} value={draft.notes} onChange={(e) => set("notes", e.target.value)} /></div>
            <div className="col-span-2 flex items-end md:col-span-4"><Check checked={draft.active} onChange={(v) => set("active", v)}>Active (included in the outlook)</Check></div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setDraft(null)} disabled={saving}>Cancel</Button>
            <Button size="sm" className="h-7 gap-1 text-xs" onClick={save} disabled={saving}><Save className="h-3 w-3" /> {saving ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      ) : null}
      {data && rows.length === 0 ? <Empty icon={CalendarClock}>No standing commitments yet. Add loans, rent, payroll and VAT so the 13-week outlook includes them.</Empty> : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead className={THEAD}><tr><TH>Name</TH><TH>Kind</TH><TH right>Amount</TH><TH>Frequency</TH><TH>Next due</TH><TH right>Balance</TH><TH>Ends</TH><TH /></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className={cn("cursor-pointer border-b border-border/40 hover:bg-muted/30", !c.active && "text-muted-foreground line-through")} onClick={() => edit(c)}>
                  <td className="p-2 font-medium">{c.name}{c.notes ? <span className="block max-w-[260px] truncate text-[10px] font-normal text-muted-foreground no-underline">{c.notes}</span> : null}</td>
                  <td className="p-2 capitalize">{c.kind}</td>
                  <td className="p-2 text-right tabular-nums">{money(c.amount)}</td>
                  <td className="p-2">{c.frequency}{c.dueDay != null && c.frequency !== "once" ? ` · day ${c.dueDay}` : ""}</td>
                  <td className="p-2">{fmtDay(c.nextDue)}</td>
                  <td className="p-2 text-right tabular-nums">{c.balance != null ? money(c.balance) : "—"}</td>
                  <td className="p-2">{fmtDay(c.endDate)}</td>
                  <td className="p-2 text-right">{c.active ? <button type="button" className="text-muted-foreground hover:text-red-500" title="Deactivate" aria-label={`Deactivate ${c.name}`} onClick={(e) => { e.stopPropagation(); deactivate(c); }}><Trash2 className="h-3.5 w-3.5" /></button> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Section>
  );
}

// ------------------------------------------------------------ playbook
export function SupplierPlaybook({ connected }: { connected: boolean }) {
  const { symbol } = useMoney();
  const { data, error, loading, reload, setData } = useApi<SuppliersResponse>("/api/finance/suppliers");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [isNew, setIsNew] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const rows = data?.profiles || null;

  const learn = async () => {
    setBusy(true); setNotice(null);
    try {
      const d = await api<{ available?: boolean; summary?: { vendorsScanned?: number; months?: number; profilesUpdated?: number; vendorsRemaining?: number; errors?: string[] } }>("/api/finance/suppliers", { method: "POST", json: { action: "learn" } });
      const s = d.summary || {};
      setNotice(`Learned from ${s.vendorsScanned ?? "?"} QuickBooks vendors (${s.months ?? "?"} months): ${s.profilesUpdated ?? 0} profiles updated${s.vendorsRemaining ? `, ${s.vendorsRemaining} remaining — run again` : ""}${s.errors?.length ? ` · ${s.errors.length} errors` : ""}.`);
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 501) setNotice("Learning from QuickBooks history is not available on this deployment yet.");
      else toast.error(e instanceof Error ? e.message : "Action failed");
    } finally { setBusy(false); }
  };
  const open = (p: SupplierRow) => { setIsNew(false); setDraft(toDraft(p)); };
  const openNew = () => { setIsNew(true); setDraft(toDraft({ vendorId: "", vendorName: "", paymentMethods: ["bacs"], pressure: "medium", allocateOldestFirst: true })); };
  const onSaved = (p: SupplierProfile) => {
    setDraft(null); toast.success(`${p.vendorName} saved`);
    setData((d) => { const list = d?.profiles || []; const i = list.findIndex((x) => x.vendorId === p.vendorId); const next = i >= 0 ? list.map((x) => (x.vendorId === p.vendorId ? { ...x, ...p } : x)) : [...list, p]; return { profiles: next.sort((a, b) => a.vendorName.localeCompare(b.vendorName)), total: next.length, pending: next.filter((x) => x.vendorId.startsWith("pending:")).length }; });
  };
  const shown = (rows || []).filter((r) => !filter || `${r.vendorName} ${r.aliases.join(" ")} ${r.defaultAccountName || ""}`.toLowerCase().includes(filter.toLowerCase()));
  const counts = rows ? { onHold: rows.filter((r) => r.onHold).length, pending: rows.filter((r) => r.vendorId.startsWith("pending:")).length, autoPost: rows.filter((r) => r.autoPost).length } : null;

  return (
    <div className="space-y-4">
      <Card id="supplier-playbook" className="p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10"><BookOpen className="h-5 w-5 text-primary" /></div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">Supplier playbook</h3>
              <p className="text-[11px] text-muted-foreground">Terms, statement accounts, block and safe days, who takes a card, who is on hold, default QuickBooks category. F5 ranks the Friday run from it, F8 codes bills from it, F7 keeps it current.{rows ? ` ${rows.length} suppliers` : ""}{counts ? ` · ${counts.pending} awaiting QuickBooks match · ${counts.onHold} on hold · ${counts.autoPost} auto-post` : ""}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <input className="h-7 w-40 rounded-md border border-input bg-background px-2 text-xs" placeholder="Filter…" aria-label="Filter suppliers" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <RefreshButton onClick={reload} loading={loading} />
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={learn} disabled={busy || !connected} title={connected ? "Fill default accounts, keyword hints and email domains from QuickBooks bill history; matches pending profiles to real vendor ids" : "Connect QuickBooks first"}><Sparkles className={cn("h-3 w-3", busy && "animate-pulse")} /> {busy ? "Learning…" : "Learn from QuickBooks history"}</Button>
            <Button size="sm" className="h-7 gap-1 text-xs" onClick={openNew}><Plus className="h-3 w-3" /> New supplier</Button>
          </div>
        </div>
        {error ? <ErrorNote>Playbook unavailable: {error}</ErrorNote> : null}
        {notice ? <p className="mb-2 text-xs text-emerald-600">{notice}</p> : null}
        {rows && rows.length === 0 && !draft ? <Empty icon={BookOpen}>No supplier profiles yet. Add your suppliers here, or connect QuickBooks and learn them from bill history.</Empty> : null}
        {draft ? <EditDrawer draft={draft} isNew={isNew} onChange={setDraft} onClose={() => setDraft(null)} onSaved={onSaved} /> : null}
        {rows && rows.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[880px] text-xs">
              <thead className={THEAD}><tr><TH>Supplier</TH><TH>Terms</TH><TH right>Block / safe</TH><TH>Pressure</TH><TH>Pay by</TH><TH>Default account</TH><TH>Flags</TH><TH right>Disputes</TH><TH>Updated</TH></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.vendorId} className={cn("cursor-pointer border-b border-border/40 hover:bg-muted/30", draft?.vendorId === r.vendorId && "bg-muted/40")} onClick={() => open(r)}>
                    <td className="p-2"><span className="font-medium">{r.vendorName}</span>{r.vendorId.startsWith("pending:") ? <span className="ml-1 text-[10px] text-amber-600" title="Not yet matched to a QuickBooks vendor">pending</span> : null}{r.aliases.length > 1 ? <span className="block max-w-[220px] truncate text-[10px] text-muted-foreground">{r.aliases.filter((a) => a !== r.vendorName).join(", ")}</span> : null}</td>
                    <td className="whitespace-nowrap p-2">{termsLabel(r.terms)}{r.statementAccount ? <span className="text-muted-foreground"> · statement</span> : null}</td>
                    <td className={cn("whitespace-nowrap p-2 text-right tabular-nums", r.blockAfterDaysOverdue != null && "font-medium text-red-500")}>{r.blockAfterDaysOverdue != null ? `blocks ${r.blockAfterDaysOverdue}d` : "—"}{r.safeDaysOverdue != null ? <span className="font-normal text-emerald-600"> / safe {r.safeDaysOverdue}d</span> : null}</td>
                    <td className="p-2"><Badge className={cn("border-0 text-[10px]", pressureTone[r.pressure])}>{r.pressure}</Badge></td>
                    <td className="p-2 text-[10px] uppercase tracking-wide">{r.paymentMethods.join(" · ")}</td>
                    <td className="p-2">{r.defaultAccountName || <span className="text-amber-600">TBC</span>}</td>
                    <td className="whitespace-nowrap p-2">
                      {r.onHold ? <Badge className="mr-1 border-0 bg-red-500/15 text-[10px] text-red-500">on hold</Badge> : null}
                      {r.proformaOnly ? <Badge className="mr-1 border-0 bg-amber-500/15 text-[10px] text-amber-600">pro-forma</Badge> : null}
                      {r.autoPost ? <Badge className="mr-1 border-0 bg-emerald-500/15 text-[10px] text-emerald-600">auto-post</Badge> : null}
                      {r.creditLimit != null ? <span className="text-[10px] text-muted-foreground">limit {symbol}{r.creditLimit.toLocaleString("en-GB")}</span> : null}
                    </td>
                    <td className={cn("p-2 text-right tabular-nums", (r.activeDisputes || 0) > 0 && "font-medium text-amber-600")}>{r.activeDisputes ? <span className="inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" />{r.activeDisputes}</span> : "—"}</td>
                    <td className="whitespace-nowrap p-2 text-[10px] text-muted-foreground">{fmtDay(r.updatedAt)}<span className="block max-w-[140px] truncate">{r.updatedBy}</span></td>
                  </tr>
                ))}
                {shown.length === 0 ? <tr><td colSpan={9} className="p-3 text-center text-muted-foreground">No supplier matches &ldquo;{filter}&rdquo;.</td></tr> : null}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      <CommitmentsCard />
    </div>
  );
}
