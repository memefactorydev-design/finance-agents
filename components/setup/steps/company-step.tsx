"use client";

import * as React from "react";
import { toast } from "sonner";
import { StepHeader, Grid, TextField, SelectField, ListField, NumberField, SaveBar, saveStep, useDraft, type StepProps } from "../fields";

const ZONES = ["Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Amsterdam", "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney", "UTC"];

// Company identity, who approves, and the default payment split every new
// project's schedule starts from.
export function CompanyStep({ connections, reload, next }: StepProps) {
  const c = connections.company;
  const f = c.finance;
  const { draft, set, dirty, setDirty } = useDraft({
    name: c.name, currency: c.currency, timezone: c.timezone, vatNumber: c.vatNumber || "", internalDomains: c.internalDomains, approverEmails: c.approverEmails, accountantEmail: c.accountantEmail || "", channelName: c.channelName,
    defaultVatRate: String(f.defaultVatRate), depositPct: String(f.depositPct), surveyPct: String(f.surveyPct), installDepositPct: String(f.installDepositPct), installDay1Pct: String(f.installDay1Pct), retentionPct: String(f.retentionPct),
  }, [connections]);
  const [saving, setSaving] = React.useState(false);
  const num = (s: string, fallback: number) => { const n = parseFloat(s); return Number.isFinite(n) ? n : fallback; };
  const save = async () => {
    if (!draft.name.trim()) { toast.error("Enter the company name"); return false; }
    setSaving(true);
    try {
      await saveStep("company", { company: { name: draft.name.trim(), currency: draft.currency, timezone: draft.timezone.trim() || "Europe/London", vatNumber: draft.vatNumber.trim() || null, internalDomains: draft.internalDomains, approverEmails: draft.approverEmails, accountantEmail: draft.accountantEmail.trim().toLowerCase() || null, channelName: draft.channelName.trim().replace(/^#/, "") || "internal-finance", finance: { defaultVatRate: num(draft.defaultVatRate, 20), depositPct: num(draft.depositPct, 35), surveyPct: num(draft.surveyPct, 35), installDepositPct: num(draft.installDepositPct, 20), installDay1Pct: num(draft.installDay1Pct, 50), retentionPct: num(draft.retentionPct, 10) } } });
      toast.success("Company saved"); setDirty(false); await reload(); return true;
    } catch (e) { toast.error(e instanceof Error ? e.message : "Save failed"); return false; } finally { setSaving(false); }
  };
  return (
    <div className="space-y-5">
      <StepHeader title="Company" intro="Who you are, who signs things off, and the default payment split the schedule is built from. Every default can be overridden per project." />
      <Grid>
        <TextField label="Company name" value={draft.name} onChange={(v) => set("name", v)} required />
        <SelectField label="Currency" value={draft.currency} onChange={(v) => set("currency", v)} options={[{ value: "GBP", label: "GBP — pound sterling" }, { value: "EUR", label: "EUR — euro" }, { value: "USD", label: "USD — US dollar" }]} />
        <div className="space-y-1"><p className="text-xs font-medium">Timezone</p><input className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm" list="tz" value={draft.timezone} onChange={(e) => set("timezone", e.target.value)} /><datalist id="tz">{ZONES.map((z) => <option key={z} value={z} />)}</datalist><p className="text-[11px] text-muted-foreground">Schedules, due dates and the agents&apos; timetable use this.</p></div>
        <TextField label="VAT number" hint="Printed on invoices and used by the accounts email agent." value={draft.vatNumber} onChange={(v) => set("vatNumber", v)} placeholder="GB123456789" />
      </Grid>
      <Grid>
        <ListField label="Internal email domains" hint="Mail from these domains is yours, not a supplier's. One per line." value={draft.internalDomains} onChange={(v) => set("internalDomains", v)} placeholder={"example.com"} />
        <ListField label="Approver emails" hint="Who approves new suppliers and final invoices (APPROVE replies in the briefs channel). One per line." env="FINANCE_APPROVER_EMAILS" value={draft.approverEmails} onChange={(v) => set("approverEmails", v)} placeholder={"owner@example.com"} />
        <TextField label="Accountant email" hint="Receives the quarter-end “ready for VAT” draft." value={draft.accountantEmail} onChange={(v) => set("accountantEmail", v)} type="email" placeholder="accounts@your-accountant.example.com" />
        <TextField label="Briefs channel name" hint="The in-app channel the agents report to (and the Slack channel name if mirrored)." value={draft.channelName} onChange={(v) => set("channelName", v)} placeholder="internal-finance" />
      </Grid>
      <div>
        <p className="mb-2 text-sm font-semibold">Default payment split</p>
        <p className="mb-3 text-[11px] text-muted-foreground">Order: deposit on order, survey payment on sign-off, the balance 14 days before delivery. Installation (separate contract): deposit, half the balance on day 1, the other half on Stage 1 sign-off, with optional retention until Stage 2.</p>
        <Grid cols={3}>
          <NumberField label="Default VAT rate %" value={draft.defaultVatRate} onChange={(v) => set("defaultVatRate", v)} min={0} max={100} step={0.5} />
          <NumberField label="Deposit % (of gross order)" value={draft.depositPct} onChange={(v) => set("depositPct", v)} min={0} max={100} />
          <NumberField label="Survey payment % (of gross order)" value={draft.surveyPct} onChange={(v) => set("surveyPct", v)} min={0} max={100} />
          <NumberField label="Installation deposit %" value={draft.installDepositPct} onChange={(v) => set("installDepositPct", v)} min={0} max={100} />
          <NumberField label="Installation day 1 % (of balance)" value={draft.installDay1Pct} onChange={(v) => set("installDay1Pct", v)} min={0} max={100} />
          <NumberField label="Retention %" value={draft.retentionPct} onChange={(v) => set("retentionPct", v)} min={0} max={100} />
        </Grid>
      </div>
      <SaveBar onSave={save} saving={saving} dirty={dirty} onNext={async () => { if (!dirty || (await save())) next(); }} />
    </div>
  );
}
