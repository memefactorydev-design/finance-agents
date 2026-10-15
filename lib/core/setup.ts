// What is configured, what is missing — drives the wizard and the status card.
import { appSecretPresent } from "./crypto";
import { envOverrides, getConnections, type Connections } from "./config";
import { owner } from "./auth";
import { qboConfigured } from "@/lib/qbo/client";
import { mailConfigured } from "@/lib/mail";

export interface SetupState {
  appSecret: boolean;
  ownerSet: boolean;
  store: "file" | "postgres";
  company: boolean;
  quickbooks: { configured: boolean; mode: Connections["quickbooks"]["mode"] };
  mail: { configured: boolean; provider: Connections["mail"]["provider"]; intake: string[]; orders: string[]; accounts: string | null };
  crm: { mode: Connections["crm"]["mode"]; configured: boolean };
  ai: { configured: boolean; extractor: Connections["ai"]["extractor"] };
  envOverrides: string[];
  completedSteps: string[];
  ready: boolean;
}
export async function setupState(): Promise<SetupState> {
  const secret = appSecretPresent();
  const cfg = secret ? await getConnections() : null;
  const o = secret ? await owner().catch(() => null) : null;
  const c = cfg;
  const crmConfigured = !c ? false : c.crm.mode === "manual" || c.crm.mode === "none" ? true : c.crm.mode === "rest" ? !!c.crm.rest.projectsUrl : c.crm.mode === "mcp" ? !!c.crm.mcp.url : c.crm.mode === "webhook" ? !!c.crm.webhook.secret : false;
  return {
    appSecret: secret,
    ownerSet: !!o,
    store: process.env.DATABASE_URL ? "postgres" : "file",
    company: !!c?.company.name,
    quickbooks: { configured: !!c && qboConfigured(c), mode: c?.quickbooks.mode || "none" },
    mail: { configured: !!c && mailConfigured(c), provider: c?.mail.provider || "none", intake: c?.mail.intakeMailboxes || [], orders: c?.mail.ordersMailboxes || [], accounts: c?.mail.accountsMailbox || null },
    crm: { mode: c?.crm.mode || "manual", configured: crmConfigured },
    ai: { configured: !!(c?.ai.anthropicApiKey || c?.ai.openaiApiKey), extractor: c?.ai.extractor || "anthropic" },
    envOverrides: envOverrides(),
    completedSteps: c?.setup.completedSteps || [],
    ready: secret && !!o && !!c?.company.name,
  };
}
