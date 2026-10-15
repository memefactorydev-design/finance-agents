// Generic IMAP/SMTP mail provider (Google Workspace with an app password,
// Fastmail, Zoho, cPanel…). One login serves every mailbox the account can
// open; "mailbox" selects the account when several are configured by using
// the same credentials, or is ignored when it matches the login user.
// Drafts are APPENDed to the Drafts folder; send goes through SMTP.
import { FinanceError } from "@/lib/core/domain";
import type { DraftInput, DraftResult, MailAttachment, MailBody, MailMessage, MailProvider } from "./types";

export interface ImapConfig { host: string; port: number; secure: boolean; user: string; password: string; smtpHost?: string; smtpPort?: number; smtpSecure?: boolean; draftsFolder?: string }

export class ImapProvider implements MailProvider {
  kind = "imap" as const;
  constructor(readonly cfg: ImapConfig) {}
  private async client() {
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({ host: this.cfg.host, port: this.cfg.port, secure: this.cfg.secure, auth: { user: this.cfg.user, pass: this.cfg.password }, logger: false });
    await client.connect();
    return client;
  }
  private async withMailbox<T>(folder: string, fn: (client: any) => Promise<T>): Promise<T> {
    const client = await this.client();
    try {
      const lock = await client.getMailboxLock(folder);
      try { return await fn(client); } finally { lock.release(); }
    } finally { await client.logout().catch(() => {}); }
  }
  async probe(_mailbox: string) {
    try { await this.withMailbox("INBOX", async () => true); return { ok: true }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : "probe_failed" }; }
  }
  private toMessage(mailbox: string, uid: number, env: any, bodyStructure: any, flags: Set<string> | undefined): MailMessage {
    const hasAttachments = !!bodyStructure && JSON.stringify(bodyStructure).includes('"disposition":"attachment"');
    return { id: String(uid), mailbox, subject: env?.subject ?? null, from: { address: env?.from?.[0]?.address ?? null, name: env?.from?.[0]?.name ?? null }, to: (env?.to || []).map((x: any) => x.address).filter(Boolean), receivedAt: (env?.date ? new Date(env.date) : new Date()).toISOString(), conversationId: env?.inReplyTo ?? null, internetMessageId: env?.messageId ?? null, hasAttachments, preview: null, webLink: null };
  }
  async listMessages(mailbox: string, opts: { folder?: string; since?: string; top?: number; search?: string }) {
    const top = Math.min(100, Math.max(1, opts.top ?? 50));
    return this.withMailbox(opts.folder || "INBOX", async (client) => {
      const query: Record<string, unknown> = {};
      if (opts.since) query.since = new Date(opts.since);
      if (opts.search) query.or = [{ subject: opts.search }, { from: opts.search }, { body: opts.search }];
      const uids: number[] = await client.search(Object.keys(query).length ? query : { all: true }, { uid: true });
      const chosen = (opts.since ? uids : uids.slice(-top)).slice(-top);
      const messages: MailMessage[] = [];
      if (chosen.length) for await (const m of client.fetch(chosen, { uid: true, envelope: true, bodyStructure: true, flags: true }, { uid: true })) messages.push(this.toMessage(mailbox, m.uid, m.envelope, m.bodyStructure, m.flags));
      messages.sort((a, b) => (opts.since ? a.receivedAt.localeCompare(b.receivedAt) : b.receivedAt.localeCompare(a.receivedAt)));
      return { messages: messages.slice(0, top), calls: 1 };
    });
  }
  private async parsed(uid: number) {
    return this.withMailbox("INBOX", async (client) => {
      const { content } = await client.download(String(uid), undefined, { uid: true });
      const chunks: Buffer[] = [];
      for await (const c of content as AsyncIterable<Buffer>) chunks.push(c);
      const { simpleParser } = await import("mailparser");
      return simpleParser(Buffer.concat(chunks));
    });
  }
  async getMessage(mailbox: string, id: string) {
    const p = await this.parsed(Number(id));
    const body: MailBody = { id, text: p.text || "", html: typeof p.html === "string" ? p.html : null };
    const from = Array.isArray(p.from?.value) ? p.from?.value[0] : undefined;
    return { id, mailbox, subject: p.subject ?? null, from: { address: from?.address ?? null, name: from?.name ?? null }, to: (Array.isArray(p.to) ? p.to : p.to ? [p.to] : []).flatMap((t) => t.value.map((v) => v.address || "")).filter(Boolean), receivedAt: (p.date || new Date()).toISOString(), conversationId: p.inReplyTo ?? null, internetMessageId: p.messageId ?? null, hasAttachments: (p.attachments || []).length > 0, preview: (p.text || "").slice(0, 200), body };
  }
  async listAttachments(_mailbox: string, id: string): Promise<MailAttachment[]> {
    const p = await this.parsed(Number(id));
    return (p.attachments || []).map((a, i) => ({ id: String(i), name: a.filename || `attachment-${i}`, contentType: (a.contentType || "").toLowerCase(), size: a.size || 0, isInline: a.contentDisposition === "inline" }));
  }
  async getAttachment(_mailbox: string, id: string, attachmentId: string) {
    const p = await this.parsed(Number(id));
    const a = (p.attachments || [])[Number(attachmentId)];
    if (!a) throw new FinanceError("ATTACHMENT_NOT_FOUND", false, 404);
    return new Uint8Array(a.content);
  }
  private async mime(mailbox: string, d: DraftInput): Promise<Buffer> {
    const nodemailer = await import("nodemailer");
    const MailComposer = (await import("nodemailer/lib/mail-composer")).default;
    void nodemailer;
    const composer = new MailComposer({ from: mailbox, to: d.to.join(", "), cc: d.cc?.join(", "), subject: d.subject, html: d.html, inReplyTo: d.replyToMessageId || undefined, attachments: (d.attachments || []).map((a) => ({ filename: a.name, contentType: a.contentType, content: Buffer.from(a.contentBytes, "base64") })) });
    return composer.compile().build();
  }
  async createDraft(mailbox: string, d: DraftInput): Promise<DraftResult> {
    const raw = await this.mime(mailbox, d);
    const client = await this.client();
    try {
      const folder = this.cfg.draftsFolder || "Drafts";
      const r = await client.append(folder, raw, ["\\Draft"]);
      return { id: String((r && typeof r === "object" && "uid" in r ? (r as { uid?: number }).uid : undefined) ?? "draft"), webLink: null, mode: "draft" };
    } finally { await client.logout().catch(() => {}); }
  }
  async send(mailbox: string, d: DraftInput): Promise<DraftResult> {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({ host: this.cfg.smtpHost || this.cfg.host.replace(/^imap\./, "smtp."), port: this.cfg.smtpPort || 465, secure: this.cfg.smtpSecure ?? true, auth: { user: this.cfg.user, pass: this.cfg.password } });
    const info = await transport.sendMail({ from: mailbox, to: d.to, cc: d.cc, subject: d.subject, html: d.html, inReplyTo: d.replyToMessageId || undefined, attachments: (d.attachments || []).map((a) => ({ filename: a.name, contentType: a.contentType, content: Buffer.from(a.contentBytes, "base64") })) });
    return { id: info.messageId || "sent", webLink: null, mode: "sent" };
  }
}
