import { getConnections, type Connections } from "@/lib/core/config";
import { FinanceError } from "@/lib/core/domain";
import { GraphProvider } from "./graph";
import { ImapProvider } from "./imap";
import type { MailProvider } from "./types";
export * from "./types";

let cache: { key: string; provider: MailProvider } | null = null;
export function mailConfigured(c: Connections): boolean {
  if (c.mail.provider === "graph") return !!(c.mail.graph.tenantId && c.mail.graph.clientId && c.mail.graph.clientSecret);
  if (c.mail.provider === "imap") return !!(c.mail.imap.host && c.mail.imap.user && c.mail.imap.password);
  return false;
}
export async function mailProvider(c?: Connections): Promise<MailProvider> {
  const cfg = c ?? (await getConnections());
  if (!mailConfigured(cfg)) throw new FinanceError("MAIL_NOT_CONFIGURED", false, 503);
  const key = JSON.stringify(cfg.mail.provider === "graph" ? cfg.mail.graph : cfg.mail.imap);
  if (cache && cache.key === key) return cache.provider;
  const provider: MailProvider = cfg.mail.provider === "graph" ? new GraphProvider(cfg.mail.graph.tenantId, cfg.mail.graph.clientId, cfg.mail.graph.clientSecret) : new ImapProvider(cfg.mail.imap);
  cache = { key, provider };
  return provider;
}
// Mailboxes this install watches. IMAP logins see one account, so the login
// user is the default mailbox when none is configured.
export function intakeMailboxes(c: Connections): string[] {
  const list = c.mail.intakeMailboxes.length ? c.mail.intakeMailboxes : [c.mail.accountsMailbox || (c.mail.provider === "imap" ? c.mail.imap.user : "")].filter(Boolean);
  return Array.from(new Set(list.map((m) => m.toLowerCase())));
}
export function ordersMailboxes(c: Connections): string[] {
  const list = c.mail.ordersMailboxes.length ? c.mail.ordersMailboxes : intakeMailboxes(c);
  return Array.from(new Set(list.map((m) => m.toLowerCase())));
}
export function accountsMailbox(c: Connections): string | null {
  return (c.mail.accountsMailbox || intakeMailboxes(c)[0] || null)?.toLowerCase() || null;
}
