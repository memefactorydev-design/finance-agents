"use client";

import * as React from "react";
import { toast } from "sonner";
import { StepHeader, Grid, Choice, TextField, SecretField, NumberField, ListField, ToggleField, TestButton, TestResult, SaveBar, saveStep, useDraft, type StepProps } from "../fields";

// Mailboxes: Microsoft 365 (app-only Graph) or IMAP/SMTP. Which mailboxes
// are scanned for supplier invoices, which for order acknowledgements, and
// which one the accounts agent drafts from. Live sending is OFF by default.
export function MailboxesStep({ connections, reload, next }: StepProps) {
  const m = connections.mail;
  const { draft, set, dirty, setDirty } = useDraft({
    provider: m.provider, tenantId: m.graph.tenantId, gClientId: m.graph.clientId, gClientSecret: m.graph.clientSecret,
    host: m.imap.host, port: String(m.imap.port), secure: m.imap.secure, user: m.imap.user, password: m.imap.password, smtpHost: m.imap.smtpHost, smtpPort: String(m.imap.smtpPort), smtpSecure: m.imap.smtpSecure, draftsFolder: m.imap.draftsFolder,
    intakeMailboxes: m.intakeMailboxes, ordersMailboxes: m.ordersMailboxes, accountsMailbox: m.accountsMailbox || "", redirectMailboxes: m.redirectMailboxes, redirectNotices: m.redirectNotices, liveSendEnabled: m.liveSendEnabled,
    partnerDomains: m.partnerDomains, partnerEmails: m.partnerEmails, blockEmails: m.blockEmails,
  }, [connections]);
  const [saving, setSaving] = React.useState(false);
  const [test, setTest] = React.useState<Record<string, unknown> | null>(null);
  const save = async () => {
    setSaving(true);
    try {
      await saveStep("mailboxes", { mail: {
        provider: draft.provider,
        graph: { tenantId: draft.tenantId.trim(), clientId: draft.gClientId.trim(), clientSecret: draft.gClientSecret },
        imap: { host: draft.host.trim(), port: Number(draft.port) || 993, secure: draft.secure, user: draft.user.trim(), password: draft.password, smtpHost: draft.smtpHost.trim(), smtpPort: Number(draft.smtpPort) || 465, smtpSecure: draft.smtpSecure, draftsFolder: draft.draftsFolder.trim() || "Drafts" },
        intakeMailboxes: draft.intakeMailboxes, ordersMailboxes: draft.ordersMailboxes, accountsMailbox: draft.accountsMailbox.trim().toLowerCase() || null, redirectMailboxes: draft.redirectMailboxes, redirectNotices: draft.redirectNotices, liveSendEnabled: draft.liveSendEnabled,
        partnerDomains: draft.partnerDomains, partnerEmails: draft.partnerEmails, blockEmails: draft.blockEmails,
      } });
      toast.success("Mailboxes saved"); setDirty(false); await reload(); return true;
    } catch (e) { toast.error(e instanceof Error ? e.message : "Save failed"); return false; } finally { setSaving(false); }
  };
  return (
    <div className="space-y-5">
      <StepHeader title="Mailboxes" intro="Where supplier invoices and order acknowledgements arrive, and the accounts mailbox the agents draft replies in. The agents never send on their own; drafts only unless you switch live sending on." />
      <Choice value={draft.provider} onChange={(v) => set("provider", v)} options={[{ value: "graph", label: "Microsoft 365", hint: "App-only Microsoft Graph: Mail.Read on the mailboxes, Mail.ReadWrite for drafts. Works with shared mailboxes." }, { value: "imap", label: "IMAP / SMTP", hint: "Any mailbox with IMAP (Google Workspace, Fastmail, your host). Drafts go to the Drafts folder." }, { value: "none", label: "Not yet", hint: "Skip — intake and acknowledgements stay off until a mailbox is configured." }]} />
      {draft.provider === "graph" ? (
        <Grid cols={3}>
          <TextField label="Tenant id" env="M365_TENANT_ID" value={draft.tenantId} onChange={(v) => set("tenantId", v)} mono />
          <TextField label="Application (client) id" env="M365_CLIENT_ID" value={draft.gClientId} onChange={(v) => set("gClientId", v)} mono />
          <SecretField label="Client secret" env="M365_CLIENT_SECRET" value={draft.gClientSecret} onChange={(v) => set("gClientSecret", v)} />
          <p className="text-[11px] text-muted-foreground sm:col-span-3">Register an app in Entra ID with application permissions Mail.Read and Mail.ReadWrite (admin consent), then restrict it to these mailboxes with an application access policy.</p>
        </Grid>
      ) : null}
      {draft.provider === "imap" ? (
        <div className="space-y-4">
          <Grid cols={3}>
            <TextField label="IMAP host" env="IMAP_HOST" value={draft.host} onChange={(v) => set("host", v)} placeholder="imap.example.com" mono />
            <NumberField label="IMAP port" env="IMAP_PORT" value={draft.port} onChange={(v) => set("port", v)} min={1} max={65535} />
            <ToggleField label="TLS (IMAPS)" env="IMAP_SECURE" checked={draft.secure} onChange={(v) => set("secure", v)} />
            <TextField label="User" env="IMAP_USER" value={draft.user} onChange={(v) => set("user", v)} placeholder="accounts@example.com" />
            <SecretField label="Password / app password" env="IMAP_PASSWORD" value={draft.password} onChange={(v) => set("password", v)} />
            <TextField label="Drafts folder" value={draft.draftsFolder} onChange={(v) => set("draftsFolder", v)} placeholder="Drafts" />
            <TextField label="SMTP host" env="SMTP_HOST" value={draft.smtpHost} onChange={(v) => set("smtpHost", v)} placeholder="smtp.example.com" mono />
            <NumberField label="SMTP port" env="SMTP_PORT" value={draft.smtpPort} onChange={(v) => set("smtpPort", v)} min={1} max={65535} />
            <ToggleField label="SMTP TLS" env="SMTP_SECURE" checked={draft.smtpSecure} onChange={(v) => set("smtpSecure", v)} />
          </Grid>
          <p className="text-[11px] text-muted-foreground">One IMAP login is used for every mailbox listed below (shared mailboxes via delegation or aliases). Use an app password where the provider offers one.</p>
        </div>
      ) : null}
      {draft.provider !== "none" ? (
        <>
          <Grid>
            <ListField label="Intake mailboxes" hint="Scanned for supplier invoices (PDF attachments). One address per line." env="FINANCE_INTAKE_MAILBOXES" value={draft.intakeMailboxes} onChange={(v) => set("intakeMailboxes", v)} placeholder={"accounts@example.com\ninfo@example.com"} />
            <ListField label="Orders mailboxes" hint="Scanned for supplier order acknowledgements." env="FINANCE_ORDERS_MAILBOXES" value={draft.ordersMailboxes} onChange={(v) => set("ordersMailboxes", v)} placeholder={"orders@example.com"} />
            <TextField label="Accounts mailbox" hint="The only mailbox the accounts agent drafts (and, if enabled, sends) from." env="FINANCE_ACCOUNTS_MAILBOX" value={draft.accountsMailbox} onChange={(v) => set("accountsMailbox", v)} placeholder="accounts@example.com" />
            <ListField label="Redirect-notice mailboxes" hint="Senders who email invoices to these mailboxes get a polite draft asking them to use the accounts address next time." value={draft.redirectMailboxes} onChange={(v) => set("redirectMailboxes", v)} placeholder={"info@example.com"} />
          </Grid>
          <div className="grid gap-3 sm:grid-cols-2">
            <ToggleField label="Create redirect notices" checked={draft.redirectNotices} onChange={(v) => set("redirectNotices", v)} hint="Drafts only — left in the mailbox for a human to send." />
            <ToggleField label="Live sending from the accounts mailbox" env="FINANCE_LIVE_SEND" checked={draft.liveSendEnabled} onChange={(v) => set("liveSendEnabled", v)}
              hint={draft.liveSendEnabled ? "ON — send_accounts_email may send to internal and partner recipients only (never to customers). Everything else stays a draft." : "OFF (default) — every agent email is saved as a draft in the accounts mailbox; nothing is sent until a human presses Send."} />
          </div>
          <details className="rounded-lg border border-border/60 p-3">
            <summary className="cursor-pointer text-sm font-medium">Recipient rules (advanced)</summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <ListField label="Partner domains" hint="Accountants, installers — may receive live mail when sending is on." value={draft.partnerDomains} onChange={(v) => set("partnerDomains", v)} />
              <ListField label="Partner emails" value={draft.partnerEmails} onChange={(v) => set("partnerEmails", v)} />
              <ListField label="Never email" hint="Addresses the agents must not draft to at all." value={draft.blockEmails} onChange={(v) => set("blockEmails", v)} />
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-2"><TestButton what="mail" label="Test mailboxes" onResult={setTest} disabled={dirty} /><span className="text-[11px] text-muted-foreground">{dirty ? "Save first, then test." : "Opens each intake mailbox and reads its folder list."}</span></div>
          <TestResult result={test} />
        </>
      ) : null}
      <SaveBar onSave={save} saving={saving} dirty={dirty} onNext={async () => { if (!dirty || (await save())) next(); }} />
    </div>
  );
}
