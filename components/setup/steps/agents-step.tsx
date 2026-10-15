"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Plus, Trash2, Bot, CheckCircle2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api, useApi } from "@/components/use-api";
import { StepHeader, Field, CopyBox, origin, type StepProps } from "../fields";
import { fmtWhen } from "@/components/finance/money";

interface ApiKeyRow { id: string; name: string; role: "admin" | "agent"; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; prefix: string }

// Mint the API key the agents use (shown once), then the two commands that
// connect Claude Code: add this app's MCP server and install the agent
// definitions. Finishing marks setup complete.
export function AgentsStep({ state, reload }: StepProps) {
  const router = useRouter();
  const { data, reload: reloadKeys } = useApi<{ keys: ApiKeyRow[] }>("/api/setup/api-keys");
  const [name, setName] = React.useState("finance-agents");
  const [role, setRole] = React.useState<"admin" | "agent">("agent");
  const [fresh, setFresh] = React.useState<{ key: string; row: ApiKeyRow } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [finishing, setFinishing] = React.useState(false);
  const appUrl = origin();
  const keys = (data?.keys || []).filter((k) => !k.revokedAt);
  const create = async () => {
    if (!name.trim()) { toast.error("Name the key (e.g. the machine it lives on)"); return; }
    setBusy(true);
    try { const r = await api<{ key: string; row: ApiKeyRow }>("/api/setup/api-keys", { method: "POST", json: { name: name.trim(), role } }); setFresh(r); toast.success("API key created — copy it now, it is not shown again"); await reloadKeys(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not create the key"); } finally { setBusy(false); }
  };
  const revoke = async (k: ApiKeyRow) => {
    if (!window.confirm(`Revoke "${k.name}"? Agents using it stop working immediately.`)) return;
    try { await api("/api/setup/api-keys", { method: "DELETE", json: { id: k.id } }); toast.success("Key revoked"); if (fresh?.row.id === k.id) setFresh(null); await reloadKeys(); } catch (e) { toast.error(e instanceof Error ? e.message : "Revoke failed"); }
  };
  const finish = async () => {
    setFinishing(true);
    try { await api("/api/setup", { method: "POST", json: { connections: {}, step: "agents", finish: true } }); toast.success("Setup complete"); await reload(); router.push("/finance"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not finish"); } finally { setFinishing(false); }
  };
  const keyShown = fresh?.key || "<key>";
  const mcpCommand = `claude mcp add --transport http finance-agents ${appUrl}/api/mcp --header "Authorization: Bearer ${keyShown}"`;
  const checks: [string, boolean][] = [["Owner login", state.ownerSet], ["Company", state.company], ["QuickBooks", state.quickbooks.configured], ["Mailboxes", state.mail.configured], [`CRM (${state.crm.mode})`, state.crm.configured], ["AI extraction key", state.ai.configured]];

  return (
    <div className="space-y-5">
      <StepHeader title="Agents & API key" intro="The ten finance agents and the accounts mailbox agent run in Claude Code on any machine and talk to this app over MCP with an API key. Agent keys can read everything and write what the tools allow; writes are attributed to the key's name." />
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
        <Field label="Key name" hint="Where it lives — e.g. the server or laptop running the agents."><Input className="h-9" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Role"><select className="h-9 rounded-lg border border-input bg-background px-3 text-sm" value={role} onChange={(e) => setRole(e.target.value as "admin" | "agent")}><option value="agent">agent</option><option value="admin">admin</option></select></Field>
        <div className="flex items-end"><Button type="button" className="gap-1.5" onClick={create} disabled={busy}><Plus className="h-4 w-4" /> {busy ? "Creating…" : "Create API key"}</Button></div>
      </div>
      {fresh ? (
        <div className="space-y-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400"><KeyRound className="h-4 w-4" /> Your new key — shown once</p>
          <CopyBox value={fresh.key} />
          <p className="text-[11px] text-muted-foreground">Store it in the machine&apos;s secret store; this page will not show it again. Revoke and re-issue if it leaks.</p>
        </div>
      ) : null}
      {keys.length ? (
        <div className="rounded-lg border border-border/60">
          <table className="w-full text-xs"><thead className="border-b border-border/60 text-[11px] uppercase tracking-wide text-muted-foreground"><tr><th className="p-2 text-left font-medium">Key</th><th className="p-2 text-left font-medium">Role</th><th className="p-2 text-left font-medium">Created</th><th className="p-2 text-left font-medium">Last used</th><th className="p-2" /></tr></thead>
            <tbody>{keys.map((k) => <tr key={k.id} className="border-b border-border/40 last:border-0"><td className="p-2"><span className="font-medium">{k.name}</span> <span className="font-mono text-muted-foreground">{k.prefix}…</span></td><td className="p-2"><Badge variant="secondary" className="text-[10px]">{k.role}</Badge></td><td className="p-2 text-muted-foreground">{fmtWhen(k.createdAt)}</td><td className="p-2 text-muted-foreground">{k.lastUsedAt ? fmtWhen(k.lastUsedAt) : "never"}</td><td className="p-2 text-right"><button type="button" className="text-muted-foreground hover:text-red-500" aria-label={`Revoke ${k.name}`} onClick={() => revoke(k)}><Trash2 className="h-3.5 w-3.5" /></button></td></tr>)}</tbody>
          </table>
        </div>
      ) : null}

      <div className="space-y-3">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><Bot className="h-4 w-4 text-primary" /> Connect Claude Code</p>
        <CopyBox label="1. Add this app as an MCP server (on the machine that runs the agents)" value={mcpCommand} />
        <CopyBox label="2. Install the agent definitions (from a checkout of this repo)" value="cp agents/*.md ~/.claude/agents/" />
        <CopyBox label="3. Run an agent by hand, then put the timetable in cron (scripts/schedule.cron.example)" value={`scripts/run-agent.sh finance-f0-orchestration "06:45 health check"`} />
        <p className="text-[11px] text-muted-foreground">Keep the app running (<code>npm run start</code> or your host) and the scheduler (<code>npm run scheduler</code>, or Vercel Cron) so intake, acknowledgements and QuickBooks health run between agent runs. The agents only draft and propose: no agent pays, approves, or creates a customer invoice.</p>
      </div>

      <div className="rounded-lg border border-border/60 p-3">
        <p className="mb-2 text-sm font-medium">Readiness</p>
        <ul className="grid gap-1 text-xs sm:grid-cols-2">{checks.map(([l, ok]) => <li key={l} className="flex items-center gap-1.5">{ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> : <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />} {l}{ok ? "" : " — optional, can be done later"}</li>)}</ul>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
        <Button type="button" onClick={finish} disabled={finishing || !state.ownerSet || !state.company} className="gap-1.5"><CheckCircle2 className="h-4 w-4" /> {finishing ? "Finishing…" : "Finish setup"}</Button>
      </div>
    </div>
  );
}
