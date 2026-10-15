"use client";

import * as React from "react";
import { ShieldCheck, Wand2, ListTree } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Field, StepHeader, Grid, Choice, TextField, SecretField, SelectField, ToggleField, CopyBox, TestButton, TestResult, SaveBar, saveStep, useDraft, origin, type StepProps } from "../fields";

// Where projects (won jobs) come from: kept here by hand, pulled from a REST
// endpoint, pushed by webhook, or read through an MCP server. The field
// mapping is only needed when the CRM's JSON does not use recognisable names.
const MAPPING_KEYS = "id, name, firstName, lastName, email, phone, postcode, address, designer, status, opsStage, wonDate, wonValue, supplierOrders, surveyOrderAt, deliveryDate, installStart, installEnd, signOff1At, signOff2At, salesCost, salesRevenue, orderCost, orderRevenue";
const WEBHOOK_EXAMPLE = `POST ${"<APP_URL>"}/api/webhooks/crm
Content-Type: application/json
X-Signature: sha256=<hex HMAC-SHA256 of the raw body under the secret>
   (or: Authorization: Bearer <secret>)

{ "projects": [
  { "id": "crm-123", "firstName": "Alex", "lastName": "Example", "email": "alex@example.com",
    "postcode": "AB1 2CD", "status": "active", "wonDate": "2026-10-01", "wonValue": 12500,
    "deliveryDate": "2026-11-20",
    "supplierOrders": [ { "id": "po-1", "reference": "PO-1001", "supplierName": "Acme Worktops", "status": "sent",
                          "lines": [ { "code": "WT-30", "description": "Worktop 3m", "qty": 2, "unitCost": 410 } ] } ] },
  { "id": "crm-099", "deleted": true }
] }`;
const randomSecret = () => { const b = new Uint8Array(24); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""); };
const parseJson = (s: string, what: string): Record<string, unknown> | null => { if (!s.trim()) return {}; try { const v = JSON.parse(s); if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>; } catch { /* fallthrough */ } toast.error(`${what} must be a JSON object`); return null; };

export function CrmStep({ state, connections, reload, next }: StepProps) {
  const c = connections.crm;
  const { draft, set, dirty, setDirty } = useDraft({
    mode: c.mode === "none" ? "manual" : c.mode,
    projectsUrl: c.rest.projectsUrl, projectUrl: c.rest.projectUrl, noteUrl: c.rest.noteUrl, bearerToken: c.rest.bearerToken, headers: Object.keys(c.rest.headers).length ? JSON.stringify(c.rest.headers, null, 2) : "", mapping: Object.keys(c.rest.mapping).length ? JSON.stringify(c.rest.mapping, null, 2) : "", rootPath: c.rest.rootPath,
    oauthEnabled: c.oauth2.enabled, authorizeUrl: c.oauth2.authorizeUrl, tokenUrl: c.oauth2.tokenUrl, oClientId: c.oauth2.clientId, oClientSecret: c.oauth2.clientSecret, scopes: c.oauth2.scopes, grant: c.oauth2.grant,
    mcpUrl: c.mcp.url, mcpToken: c.mcp.token, listTool: c.mcp.listTool, getTool: c.mcp.getTool, noteTool: c.mcp.noteTool, listArgs: Object.keys(c.mcp.listArgs).length ? JSON.stringify(c.mcp.listArgs, null, 2) : "",
    webhookSecret: c.webhook.secret,
  }, [connections]);
  const [saving, setSaving] = React.useState(false);
  const [test, setTest] = React.useState<Record<string, unknown> | null>(null);
  const webhookUrl = `${origin()}/api/webhooks/crm`;
  const save = async () => {
    const headers = parseJson(draft.headers, "Headers"); const mapping = parseJson(draft.mapping, "Field mapping"); const listArgs = parseJson(draft.listArgs, "List tool arguments");
    if (!headers || !mapping || !listArgs) return false;
    setSaving(true);
    try {
      await saveStep("crm", { crm: {
        mode: draft.mode,
        rest: { projectsUrl: draft.projectsUrl.trim(), projectUrl: draft.projectUrl.trim(), noteUrl: draft.noteUrl.trim(), bearerToken: draft.bearerToken, headers, mapping, rootPath: draft.rootPath.trim() },
        oauth2: { enabled: draft.oauthEnabled, authorizeUrl: draft.authorizeUrl.trim(), tokenUrl: draft.tokenUrl.trim(), clientId: draft.oClientId.trim(), clientSecret: draft.oClientSecret, scopes: draft.scopes.trim(), grant: draft.grant },
        mcp: { url: draft.mcpUrl.trim(), token: draft.mcpToken, listTool: draft.listTool.trim() || "list_projects", getTool: draft.getTool.trim(), noteTool: draft.noteTool.trim(), listArgs },
        webhook: { secret: draft.webhookSecret },
      } });
      toast.success("CRM settings saved"); setDirty(false); await reload(); return true;
    } catch (e) { toast.error(e instanceof Error ? e.message : "Save failed"); return false; } finally { setSaving(false); }
  };
  const connectOauth = async () => { if (dirty && !(await save())) return; window.location.href = "/api/oauth/crm/connect"; };
  const tools = Array.isArray(test?.tools) ? (test!.tools as string[]) : null;
  return (
    <div className="space-y-5">
      <StepHeader title="CRM" intro="Projects are the won jobs the money model runs on. Keep them here, or connect the system that already has them. Receipts, invoices and finance overrides recorded in this app survive every re-sync." />
      <Choice value={draft.mode} onChange={(v) => set("mode", v)} env="CRM_MODE" options={[
        { value: "manual", label: "Manual", hint: "Create and edit projects on the Projects page. Simplest; no connector." },
        { value: "rest", label: "REST pull", hint: "This app fetches a JSON list of projects from your CRM on a schedule (bearer token or OAuth2)." },
        { value: "webhook", label: "Webhook push", hint: "Your CRM POSTs projects to this app when they change (HMAC-signed)." },
        { value: "mcp", label: "MCP server", hint: "Your CRM exposes an MCP server with a list-projects tool; this app calls it." },
      ]} />

      {draft.mode === "rest" ? (
        <div className="space-y-4">
          <Grid>
            <TextField label="Projects URL" hint="GET returns the array of projects (or an object; set the root path below)." env="CRM_REST_PROJECTS_URL" value={draft.projectsUrl} onChange={(v) => set("projectsUrl", v)} placeholder="https://crm.example.com/api/projects?status=won" mono />
            <TextField label="Root path (optional)" hint='JSON path to the array inside the response, e.g. "data.items".' value={draft.rootPath} onChange={(v) => set("rootPath", v)} mono />
            <TextField label="Single project URL (optional)" hint="{id} is replaced." value={draft.projectUrl} onChange={(v) => set("projectUrl", v)} placeholder="https://crm.example.com/api/projects/{id}" mono />
            <TextField label="Note write-back URL (optional)" hint="POST {projectId, text, by} when a note is added here." value={draft.noteUrl} onChange={(v) => set("noteUrl", v)} placeholder="https://crm.example.com/api/projects/{id}/notes" mono />
            <SecretField label="Bearer token" hint="Ignored when OAuth2 is enabled." env="CRM_REST_TOKEN" value={draft.bearerToken} onChange={(v) => set("bearerToken", v)} />
            <Field label="Extra headers (JSON)" hint='e.g. {"X-Api-Version": "2"}'><Textarea className="min-h-[72px] font-mono text-xs" value={draft.headers} onChange={(e) => set("headers", e.target.value)} placeholder="{}" /></Field>
          </Grid>
          <Field label="Field mapping (JSON, optional)" hint={<>Our field → JSON path in your payload. Common names are recognised without a mapping. Keys: <span className="font-mono">{MAPPING_KEYS}</span>.</>}>
            <Textarea className="min-h-[96px] font-mono text-xs" value={draft.mapping} onChange={(e) => set("mapping", e.target.value)} placeholder={'{ "id": "deal.id", "lastName": "contact.surname", "wonValue": "deal.amount", "wonDate": "deal.closed_at" }'} />
          </Field>
          <details className="rounded-lg border border-border/60 p-3" open={draft.oauthEnabled}>
            <summary className="cursor-pointer text-sm font-medium">OAuth2 (instead of a bearer token)</summary>
            <div className="mt-3 space-y-4">
              <ToggleField label="Use OAuth2" checked={draft.oauthEnabled} onChange={(v) => set("oauthEnabled", v)} hint="Authorization code: one-time consent, refresh token stored encrypted. Client credentials: unattended." />
              <Grid>
                <SelectField label="Grant" value={draft.grant} onChange={(v) => set("grant", v)} options={[{ value: "authorization_code", label: "Authorization code (consent screen)" }, { value: "client_credentials", label: "Client credentials (server to server)" }]} />
                <TextField label="Scopes" value={draft.scopes} onChange={(v) => set("scopes", v)} placeholder="projects.read notes.write" />
                <TextField label="Authorize URL" value={draft.authorizeUrl} onChange={(v) => set("authorizeUrl", v)} placeholder="https://crm.example.com/oauth/authorize" mono />
                <TextField label="Token URL" value={draft.tokenUrl} onChange={(v) => set("tokenUrl", v)} placeholder="https://crm.example.com/oauth/token" mono />
                <TextField label="Client id" value={draft.oClientId} onChange={(v) => set("oClientId", v)} mono />
                <SecretField label="Client secret" value={draft.oClientSecret} onChange={(v) => set("oClientSecret", v)} />
              </Grid>
              <CopyBox label="Redirect URI to register with your CRM" value={`${origin()}/api/oauth/crm/callback`} />
              {draft.grant === "authorization_code" ? <Button type="button" className="gap-1.5" onClick={connectOauth} disabled={!draft.oauthEnabled || !draft.authorizeUrl || !draft.oClientId}><ShieldCheck className="h-4 w-4" /> {dirty ? "Save & connect" : "Connect CRM"}</Button> : null}
            </div>
          </details>
        </div>
      ) : null}

      {draft.mode === "webhook" ? (
        <div className="space-y-4">
          <CopyBox label="Webhook URL — point your CRM here" value={webhookUrl} />
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1"><SecretField label="Shared secret" hint="Your CRM signs each request with it (HMAC-SHA256 in X-Signature) or sends it as a bearer token." env="CRM_WEBHOOK_SECRET" value={draft.webhookSecret} onChange={(v) => set("webhookSecret", v)} /></div>
            <Button type="button" variant="outline" className="gap-1.5" onClick={() => { const s = randomSecret(); set("webhookSecret", s); toast.success("Secret generated — copy it to your CRM, then save"); }}><Wand2 className="h-4 w-4" /> Generate</Button>
          </div>
          {draft.webhookSecret && !/^••••/.test(draft.webhookSecret) ? <CopyBox label="New secret (copy now — it is masked after saving)" value={draft.webhookSecret} /> : null}
          <Field label="Payload" hint={<>One project, an array, or <span className="font-mono">{"{projects: [...]}"}</span>. Deletions: <span className="font-mono">{"{id, deleted: true}"}</span>. Field names as in the REST mapping keys; unknown shapes can be mapped with the same field mapping (set in REST mode).</>}>
            <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px]">{WEBHOOK_EXAMPLE.replace("<APP_URL>", origin())}</pre>
          </Field>
        </div>
      ) : null}

      {draft.mode === "mcp" ? (
        <div className="space-y-4">
          <Grid>
            <TextField label="MCP server URL" hint="Streamable HTTP endpoint." env="CRM_MCP_URL" value={draft.mcpUrl} onChange={(v) => set("mcpUrl", v)} placeholder="https://crm.example.com/api/mcp" mono />
            <SecretField label="Bearer token" env="CRM_MCP_TOKEN" value={draft.mcpToken} onChange={(v) => set("mcpToken", v)} />
            <TextField label="List tool" hint="Returns the projects array." value={draft.listTool} onChange={(v) => set("listTool", v)} placeholder="list_projects" mono />
            <TextField label="Get tool (optional)" value={draft.getTool} onChange={(v) => set("getTool", v)} placeholder="get_project" mono />
            <TextField label="Note tool (optional)" hint="Called with {projectId, text, by} when a note is added here." value={draft.noteTool} onChange={(v) => set("noteTool", v)} placeholder="add_project_note" mono />
            <Field label="List tool arguments (JSON)"><Textarea className="min-h-[72px] font-mono text-xs" value={draft.listArgs} onChange={(e) => set("listArgs", e.target.value)} placeholder='{ "status": "won", "limit": 500 }' /></Field>
          </Grid>
          {tools ? <div className="rounded-lg border border-border/60 p-3 text-xs"><p className="mb-1 flex items-center gap-1 font-medium"><ListTree className="h-3.5 w-3.5" /> Tools the server offers</p><div className="flex flex-wrap gap-1">{tools.map((t) => <button key={t} type="button" className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${t === draft.listTool ? "border-primary bg-primary/10 text-primary" : "border-border/60 hover:bg-muted/40"}`} onClick={() => set("listTool", t)} title="Use as the list tool">{t}</button>)}</div></div> : null}
        </div>
      ) : null}

      {draft.mode === "manual" ? <p className="rounded-lg border border-border/60 p-3 text-sm text-muted-foreground">Projects are created and edited on the Projects page. You can switch to a connector later; projects you created here keep their finance data.</p> : null}
      <div className="flex flex-wrap items-center gap-2"><TestButton what="crm" label={draft.mode === "mcp" ? "List tools & test" : "Test connection"} onResult={setTest} disabled={dirty} /><span className="text-[11px] text-muted-foreground">{dirty ? "Save first, then test." : draft.mode === "rest" ? "Fetches the projects list and shows the first three." : draft.mode === "mcp" ? "Lists the server's tools and, if the list tool exists, fetches projects." : draft.mode === "webhook" ? "Confirms the secret is set and shows the URL." : "Manual mode needs no connection."}</span></div>
      <TestResult result={test} />
      <SaveBar onSave={save} saving={saving} dirty={dirty} onNext={async () => { if (!dirty || (await save())) next(); }}>
        {state.crm.configured ? <span className="text-[11px] text-emerald-600">CRM configured ({state.crm.mode})</span> : null}
      </SaveBar>
    </div>
  );
}
