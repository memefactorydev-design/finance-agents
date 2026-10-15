// Sending as the accounts mailbox. HARD RULE: drafts only until the owner
// switches live sending on, and clients / unknown addresses are always
// drafted for a human to send. Recipient classes: staff (internal domains),
// supplier (supplier profile contacts / domains), partner (allow-listed),
// client (an address on a project), unknown (everything else → draft).
import { getConnections } from "@/lib/core/config";
import { FinanceError } from "@/lib/core/domain";
import { domainOf, isEmail } from "@/lib/core/text";
import { listProjects } from "@/lib/crm/projects";
import { listSupplierProfiles } from "@/lib/finance/suppliers";
import { accountsMailbox, mailProvider } from "./index";

export type RecipientClass = "staff" | "supplier" | "partner" | "client" | "unknown";
export const SENDABLE: RecipientClass[] = ["staff", "supplier", "partner"];
export interface Classified { email: string; kind: RecipientClass; reason: string }

const parseList = (list: string | string[] | undefined) => (Array.isArray(list) ? list : String(list || "").split(/[,;]/)).map((a) => a.trim().toLowerCase()).filter(isEmail);

export async function classifyRecipients(addresses: string[]): Promise<Classified[]> {
  const cfg = await getConnections();
  const [profiles, projects] = await Promise.all([listSupplierProfiles().catch(() => []), addresses.length ? listProjects().catch(() => []) : Promise.resolve([])]);
  const supplierEmails = new Set<string>(), supplierDomains = new Set<string>();
  for (const p of profiles) { for (const d of p.emailDomains) supplierDomains.add(d.toLowerCase()); for (const c of p.contacts) if (c.email) { supplierEmails.add(c.email.toLowerCase()); const d = domainOf(c.email); if (d) supplierDomains.add(d); } }
  const clientEmails = new Set(projects.map((p) => (p.email || "").toLowerCase()).filter(Boolean));
  const internal = new Set(cfg.company.internalDomains.map((d) => d.toLowerCase()));
  return addresses.map((email) => {
    const e = email.toLowerCase(), d = domainOf(e) || "";
    if (cfg.mail.blockEmails.includes(e)) return { email: e, kind: "client" as const, reason: "blocked by policy" };
    if (clientEmails.has(e)) return { email: e, kind: "client" as const, reason: "address belongs to a project (client)" };
    if (internal.has(d)) return { email: e, kind: "staff" as const, reason: "internal domain" };
    if (supplierEmails.has(e) || supplierDomains.has(d)) return { email: e, kind: "supplier" as const, reason: "supplier profile" };
    if (cfg.mail.partnerEmails.includes(e) || cfg.mail.partnerDomains.includes(d)) return { email: e, kind: "partner" as const, reason: "allow-listed partner" };
    return { email: e, kind: "unknown" as const, reason: "not a known staff, supplier or partner address" };
  });
}

export interface AccountsMail { to: string | string[]; cc?: string | string[]; subject: string; html: string; attachments?: { name: string; contentType: string; contentBytes: string }[]; actor: string; replyToMessageId?: string | null }
export interface AccountsMailResult { sent: boolean; mode: "sent" | "draft"; reason: string; recipients: Classified[]; draftId?: string; webLink?: string | null; mailbox: string }

export async function sendFromAccounts(mail: AccountsMail): Promise<AccountsMailResult> {
  const cfg = await getConnections();
  const mailbox = accountsMailbox(cfg);
  if (!mailbox) throw new FinanceError("ACCOUNTS_MAILBOX_NOT_CONFIGURED", false, 503);
  const provider = await mailProvider(cfg);
  const to = parseList(mail.to), cc = parseList(mail.cc);
  if (!to.length) throw new FinanceError("NO_VALID_RECIPIENT", false, 422);
  const recipients = await classifyRecipients([...to, ...cc]);
  const blocked = recipients.filter((r) => !SENDABLE.includes(r.kind));
  const footer = `<p style="color:#64748b;font-size:11px;margin-top:16px">Prepared by Finance Agents on behalf of Accounts · requested by ${mail.actor}</p>`;
  const draft = { to, cc, subject: mail.subject, html: `${mail.html}${footer}`, attachments: mail.attachments, replyToMessageId: mail.replyToMessageId || null };
  if (!cfg.mail.liveSendEnabled) {
    const d = await provider.createDraft(mailbox, draft);
    return { sent: false, mode: "draft", reason: "Draft-only mode: live sending from the accounts mailbox is switched off (every message is drafted for a human to send)", recipients, draftId: d.id, webLink: d.webLink, mailbox };
  }
  if (blocked.length) {
    const d = await provider.createDraft(mailbox, draft);
    return { sent: false, mode: "draft", reason: `Draft only — ${blocked.map((b) => `${b.email} (${b.kind}: ${b.reason})`).join("; ")}`, recipients, draftId: d.id, webLink: d.webLink, mailbox };
  }
  const s = await provider.send(mailbox, draft);
  return { sent: true, mode: "sent", reason: "All recipients are staff, suppliers or allow-listed partners", recipients, draftId: s.id, mailbox };
}
