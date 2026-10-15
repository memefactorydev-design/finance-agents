"use client";

import * as React from "react";
import { ShieldCheck, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/components/use-api";
import { StepHeader, Grid, Choice, TextField, SecretField, SelectField, ToggleField, CopyBox, TestButton, TestResult, SaveBar, saveStep, useDraft, origin, type StepProps } from "../fields";

// QuickBooks Online: your own Intuit app (OAuth, redirect URI shown ready to
// paste into the Intuit developer portal) or Composio. Posting stays OFF
// until you flip it: every write is a dry run that stores the exact payload.
export function QuickBooksStep({ state, connections, reload, next }: StepProps) {
  const q = connections.quickbooks;
  const defaultRedirect = `${origin()}/api/oauth/qbo/callback`;
  const { draft, set, dirty, setDirty } = useDraft({ mode: q.mode, environment: q.environment, clientId: q.clientId, clientSecret: q.clientSecret, redirectUri: q.redirectUri || defaultRedirect, realmId: q.realmId, composioApiKey: q.composioApiKey, composioConnectedAccountId: q.composioConnectedAccountId, postBills: q.postBills, ledgerSince: q.ledgerSince }, [connections]);
  const [saving, setSaving] = React.useState(false);
  const [test, setTest] = React.useState<Record<string, unknown> | null>(null);
  const save = async () => {
    setSaving(true);
    try { await saveStep("quickbooks", { quickbooks: { ...draft, redirectUri: draft.redirectUri.trim(), clientId: draft.clientId.trim(), realmId: draft.realmId.trim(), composioConnectedAccountId: draft.composioConnectedAccountId.trim() } }); toast.success("QuickBooks settings saved"); setDirty(false); await reload(); return true; }
    catch (e) { toast.error(e instanceof Error ? e.message : "Save failed"); return false; } finally { setSaving(false); }
  };
  const connect = async () => { if (dirty && !(await save())) return; window.location.href = "/api/oauth/qbo/connect"; };
  const disconnect = async () => {
    if (!window.confirm("Disconnect QuickBooks? Reads and posting stop until you reconnect.")) return;
    try { await api("/api/oauth/qbo/disconnect", { method: "POST", json: {} }); toast.success("Disconnected"); await reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "Disconnect failed"); }
  };
  const configured = state.quickbooks.configured;
  return (
    <div className="space-y-5">
      <StepHeader title="QuickBooks Online" intro="The ledger the agents read (bills, customers, classes, balances) and, once you allow it, post supplier bills to. Choose how to connect." />
      <Choice value={draft.mode} onChange={(v) => set("mode", v)} env={state.envOverrides.includes("COMPOSIO_QBO_CONNECTED_ACCOUNT_ID") ? "COMPOSIO_QBO_CONNECTED_ACCOUNT_ID" : state.envOverrides.includes("QBO_CLIENT_ID") ? "QBO_CLIENT_ID" : undefined}
        options={[{ value: "oauth", label: "Your own Intuit app", hint: "Create an app at developer.intuit.com; paste the client id and secret; connect with OAuth." }, { value: "composio", label: "Composio", hint: "Use a QuickBooks connected account from your Composio workspace." }, { value: "none", label: "Not yet", hint: "Skip for now — intake still extracts invoices; nothing can be posted." }]} />
      {draft.mode === "oauth" ? (
        <div className="space-y-4">
          <Grid>
            <TextField label="Client id" env="QBO_CLIENT_ID" value={draft.clientId} onChange={(v) => set("clientId", v)} mono placeholder="ABxxxx…" />
            <SecretField label="Client secret" env="QBO_CLIENT_SECRET" value={draft.clientSecret} onChange={(v) => set("clientSecret", v)} />
            <SelectField label="Environment" env="QBO_ENVIRONMENT" value={draft.environment} onChange={(v) => set("environment", v)} options={[{ value: "production", label: "Production" }, { value: "sandbox", label: "Sandbox" }]} />
            <TextField label="Company (realm) id — optional" hint="Leave blank: the first consent binds the company." env="QBO_REALM_ID" value={draft.realmId} onChange={(v) => set("realmId", v)} mono />
          </Grid>
          <TextField label="Redirect URI" hint="Must match exactly in the Intuit app's Keys & credentials → Redirect URIs." env="QBO_REDIRECT_URI" value={draft.redirectUri} onChange={(v) => set("redirectUri", v)} mono />
          <CopyBox label="Paste this into the Intuit developer portal" value={draft.redirectUri || defaultRedirect} />
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 p-3">
            <Badge className={state.quickbooks.configured ? "border-0 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "border-0 bg-muted text-muted-foreground"}>{configured ? "credentials saved" : "not configured"}</Badge>
            <Button type="button" className="gap-1.5" onClick={connect} disabled={!draft.clientId || (!draft.clientSecret && !state.envOverrides.includes("QBO_CLIENT_SECRET"))}><ShieldCheck className="h-4 w-4" /> {dirty ? "Save & connect QuickBooks" : "Connect QuickBooks"}</Button>
            <Button type="button" variant="outline" className="gap-1.5" onClick={disconnect} disabled={!configured}><Unplug className="h-4 w-4" /> Disconnect</Button>
            <span className="text-[11px] text-muted-foreground">Connecting opens Intuit&apos;s consent screen and returns here.</span>
          </div>
        </div>
      ) : null}
      {draft.mode === "composio" ? (
        <Grid>
          <SecretField label="Composio API key" env="COMPOSIO_API_KEY" value={draft.composioApiKey} onChange={(v) => set("composioApiKey", v)} />
          <TextField label="QuickBooks connected account id" hint="From the Composio dashboard, the QuickBooks connection's id." env="COMPOSIO_QBO_CONNECTED_ACCOUNT_ID" value={draft.composioConnectedAccountId} onChange={(v) => set("composioConnectedAccountId", v)} mono />
          <SelectField label="Environment" env="QBO_ENVIRONMENT" value={draft.environment} onChange={(v) => set("environment", v)} options={[{ value: "production", label: "Production" }, { value: "sandbox", label: "Sandbox" }]} />
        </Grid>
      ) : null}
      {draft.mode !== "none" ? (
        <div className="space-y-3">
          <ToggleField label="Post bills to QuickBooks" env="FINANCE_POST_BILLS" checked={draft.postBills} onChange={(v) => set("postBills", v)}
            hint={draft.postBills ? "ON — approved supplier bills are written to QuickBooks (with their PDF). Dispute memos and posted-bill edits are written too. Nothing is paid; nothing is auto-posted unless autopilot says so." : "OFF (dry run) — every QuickBooks write records the exact payload on the item and creates nothing. Review a few dry-run payloads in Finance Agents ▸ Supplier invoices, then switch this on."} />
          <TextField label="Ledger history from" hint="How far back the ledger copy reads bills for the Completion P&L (YYYY-MM-DD)." value={draft.ledgerSince} onChange={(v) => set("ledgerSince", v)} type="date" />
          <div className="flex flex-wrap items-center gap-2"><TestButton what="quickbooks" onResult={setTest} disabled={dirty} /><span className="text-[11px] text-muted-foreground">{dirty ? "Save first, then test." : "Reads company info with the stored token."}</span></div>
          <TestResult result={test} />
        </div>
      ) : null}
      <SaveBar onSave={save} saving={saving} dirty={dirty} onNext={async () => { if (!dirty || (await save())) next(); }} />
    </div>
  );
}
