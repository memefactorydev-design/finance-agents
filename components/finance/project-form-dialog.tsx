"use client";

import * as React from "react";
import { FolderPlus, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Project, ProjectStatus } from "@/lib/crm/types";
import { api, useMoney } from "@/components/use-api";
import { label } from "./section";

// Create or edit a project kept in this app (manual CRM mode). CRM-synced
// projects are read-only here; their fields come from the connector.
type Draft = { firstName: string; lastName: string; email: string; phone: string; postcode: string; address: string; designer: string; status: ProjectStatus; opsStage: string; wonDate: string; wonValue: string; surveyOrderAt: string; deliveryDate: string; installStart: string; installEnd: string; signOff1At: string; signOff2At: string; supplyOnly: boolean; notes: string };
const toDraft = (p: Project | null): Draft => ({
  firstName: p?.firstName || "", lastName: p?.lastName || "", email: p?.email || "", phone: p?.phone || "", postcode: p?.postcode || "", address: p?.address || "", designer: p?.designer || "",
  status: p?.status || "active", opsStage: p?.opsStage || "", wonDate: p?.wonDate?.slice(0, 10) || new Date().toISOString().slice(0, 10), wonValue: p?.wonValue != null ? String(p.wonValue) : "",
  surveyOrderAt: p?.surveyOrderAt?.slice(0, 10) || "", deliveryDate: p?.deliveryDate?.slice(0, 10) || "", installStart: p?.installStart?.slice(0, 10) || "", installEnd: p?.installEnd?.slice(0, 10) || "", signOff1At: p?.signOff1At?.slice(0, 10) || "", signOff2At: p?.signOff2At?.slice(0, 10) || "",
  supplyOnly: !!p?.supplyOnly, notes: p?.notes || "",
});
const nul = (s: string) => (s.trim() ? s.trim() : null);

// Hoisted so the inputs keep their identity (and focus) across re-renders.
function DateField({ value, onChange, label: l }: { value: string; onChange: (v: string) => void; label: string }) {
  return <div><p className={label}>{l}</p><Input type="date" className="h-9" value={value} onChange={(e) => onChange(e.target.value)} /></div>;
}

export function ProjectFormDialog({ open, onOpenChange, project, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; project: Project | null; onSaved: (p: Project) => void }) {
  const { symbol } = useMoney();
  const [d, setD] = React.useState<Draft>(() => toDraft(project));
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (open) setD(toDraft(project)); }, [open, project]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const submit = async () => {
    if (!d.lastName.trim() && !d.firstName.trim()) { toast.error("Enter the client's name"); return; }
    const wonValue = d.wonValue.trim() === "" ? null : Number(d.wonValue);
    if (wonValue != null && (!Number.isFinite(wonValue) || wonValue < 0)) { toast.error("Net value must be a number"); return; }
    const body = { firstName: d.firstName.trim(), lastName: d.lastName.trim() || d.firstName.trim(), email: nul(d.email), phone: nul(d.phone), postcode: nul(d.postcode), address: nul(d.address), designer: nul(d.designer), status: d.status, opsStage: nul(d.opsStage), wonDate: nul(d.wonDate), wonValue, surveyOrderAt: nul(d.surveyOrderAt), deliveryDate: nul(d.deliveryDate), installStart: nul(d.installStart), installEnd: nul(d.installEnd), signOff1At: nul(d.signOff1At), signOff2At: nul(d.signOff2At), supplyOnly: d.supplyOnly, notes: nul(d.notes) };
    setBusy(true);
    try {
      const r = project
        ? await api<{ project: Project }>(`/api/finance/projects/${encodeURIComponent(project.id)}`, { method: "PATCH", json: body })
        : await api<{ project: Project }>("/api/finance/projects", { method: "POST", json: body });
      toast.success(project ? "Project updated" : "Project created");
      onSaved(r.project); onOpenChange(false);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Save failed"); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{project ? <Pencil className="h-4 w-4 text-primary" /> : <FolderPlus className="h-4 w-4 text-primary" />} {project ? "Edit project" : "New project"}</DialogTitle>
          <DialogDescription>The contract value is net of VAT and excludes installation; the payment schedule is built from it and the milestone dates below.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="col-span-1"><p className={label}>First name</p><Input className="h-9" value={d.firstName} onChange={(e) => set("firstName", e.target.value)} /></div>
          <div className="col-span-1"><p className={label}>Last name</p><Input className="h-9" value={d.lastName} onChange={(e) => set("lastName", e.target.value)} /></div>
          <div className="col-span-2"><p className={label}>Email</p><Input className="h-9" type="email" value={d.email} onChange={(e) => set("email", e.target.value)} /></div>
          <div className="col-span-1"><p className={label}>Phone</p><Input className="h-9" value={d.phone} onChange={(e) => set("phone", e.target.value)} /></div>
          <div className="col-span-1"><p className={label}>Postcode</p><Input className="h-9" value={d.postcode} onChange={(e) => set("postcode", e.target.value)} /></div>
          <div className="col-span-2"><p className={label}>Address</p><Input className="h-9" value={d.address} onChange={(e) => set("address", e.target.value)} /></div>
          <div className="col-span-2"><p className={label}>Salesperson (email or name)</p><Input className="h-9" value={d.designer} onChange={(e) => set("designer", e.target.value)} /></div>
          <div className="col-span-1"><p className={label}>Status</p><Select value={d.status} onValueChange={(v) => set("status", v as ProjectStatus)}><SelectTrigger className="h-9"><SelectValue /></SelectTrigger><SelectContent>{(["active", "completed", "cancelled", "lost"] as ProjectStatus[]).map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select></div>
          <div className="col-span-1"><p className={label}>Stage (free text)</p><Input className="h-9" value={d.opsStage} onChange={(e) => set("opsStage", e.target.value)} placeholder="Survey, Delivery…" /></div>
          <DateField value={d.wonDate} onChange={(v) => set("wonDate", v)} label="Won date" />
          <div className="col-span-1"><p className={label}>Net order value {symbol} (ex VAT)</p><Input className="h-9" type="number" inputMode="decimal" min={0} value={d.wonValue} onChange={(e) => set("wonValue", e.target.value)} /></div>
          <DateField value={d.surveyOrderAt} onChange={(v) => set("surveyOrderAt", v)} label="Survey sign-off" />
          <DateField value={d.deliveryDate} onChange={(v) => set("deliveryDate", v)} label="Delivery date" />
          <DateField value={d.installStart} onChange={(v) => set("installStart", v)} label="Installation start" />
          <DateField value={d.installEnd} onChange={(v) => set("installEnd", v)} label="Installation end" />
          <DateField value={d.signOff1At} onChange={(v) => set("signOff1At", v)} label="Stage 1 sign-off" />
          <DateField value={d.signOff2At} onChange={(v) => set("signOff2At", v)} label="Stage 2 sign-off" />
          <label className="col-span-2 flex h-9 items-end gap-2 text-xs"><Switch checked={d.supplyOnly} onCheckedChange={(c) => set("supplyOnly", c)} /> Supply only (no installation contract)</label>
          <div className="col-span-2 sm:col-span-4"><p className={label}>Notes</p><Textarea className="min-h-[60px]" value={d.notes} onChange={(e) => set("notes", e.target.value)} /></div>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? "Saving…" : project ? "Save changes" : "Create project"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
