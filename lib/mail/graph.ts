// Microsoft 365 (Entra app-only / client credentials) mail provider.
// Needs Mail.ReadWrite application permission scoped by an Exchange
// Application Access Policy to the finance mailboxes; Mail.Send only if you
// switch live sending on.
import { FinanceError } from "@/lib/core/domain";
import type { DraftInput, DraftResult, MailAttachment, MailBody, MailMessage, MailProvider } from "./types";

const GRAPH = "https://graph.microsoft.com/v1.0";
export class GraphProvider implements MailProvider {
  kind = "graph" as const;
  private token: { value: string; expiresAt: number } | null = null;
  constructor(readonly tenantId: string, readonly clientId: string, readonly clientSecret: string) {}
  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(this.tenantId)}/oauth2/v2.0/token`, { method: "POST", cache: "no-store", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new FinanceError(`GRAPH_TOKEN: ${data.error_description || data.error || r.status}`, false, 502);
    this.token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in || 3600) - 120) * 1000 };
    return this.token.value;
  }
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `${GRAPH}${path}`;
    const run = async (force = false) => fetch(url, { ...init, cache: "no-store", headers: { Authorization: `Bearer ${await this.accessToken(force)}`, ...(init.headers || {}) } });
    let r = await run();
    if (r.status === 401) r = await run(true);
    if (r.status === 429) { const wait = Math.min(10_000, (parseInt(r.headers.get("retry-after") || "2", 10) || 2) * 1000); await new Promise((res) => setTimeout(res, wait)); r = await run(); }
    return r;
  }
  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await this.fetch(path, init);
    if (r.status === 202 || r.status === 204) return {} as T;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new FinanceError(`GRAPH_${r.status}: ${(j as any)?.error?.code || ""} ${(j as any)?.error?.message || ""}`.trim(), r.status === 429 || r.status >= 500, 502);
    return j as T;
  }
  async probe(mailbox: string) {
    try {
      const r = await this.fetch(`/users/${encodeURIComponent(mailbox)}/mailFolders/inbox?$select=id`);
      if (r.ok) return { ok: true };
      const data = await r.json().catch(() => ({}));
      return { ok: false, error: `${data?.error?.code || `Graph ${r.status}`}${data?.error?.message ? `: ${String(data.error.message).slice(0, 160)}` : ""}` };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "probe_failed" }; }
  }
  private toMessage(mailbox: string, m: any): MailMessage {
    return { id: m.id, mailbox, subject: m.subject ?? null, from: { address: m.from?.emailAddress?.address ?? null, name: m.from?.emailAddress?.name ?? null }, to: (m.toRecipients || []).map((x: any) => x.emailAddress?.address).filter(Boolean), receivedAt: m.receivedDateTime, conversationId: m.conversationId ?? null, internetMessageId: m.internetMessageId ?? null, hasAttachments: m.hasAttachments !== false, preview: m.bodyPreview ?? null, webLink: m.webLink ?? null };
  }
  async listMessages(mailbox: string, opts: { folder?: string; since?: string; top?: number; search?: string }) {
    const folder = encodeURIComponent(opts.folder || "inbox");
    const select = "$select=id,subject,from,toRecipients,receivedDateTime,conversationId,internetMessageId,hasAttachments,bodyPreview,webLink";
    const top = Math.min(100, Math.max(1, opts.top ?? 50));
    const messages: MailMessage[] = [];
    let calls = 0;
    let next: string | null = opts.search
      ? `/users/${encodeURIComponent(mailbox)}/mailFolders/${folder}/messages?$search=${encodeURIComponent(`"${opts.search.replace(/"/g, "")}"`)}&$top=${top}&${select}`
      : `/users/${encodeURIComponent(mailbox)}/mailFolders/${folder}/messages?${opts.since ? `$filter=${encodeURIComponent(`receivedDateTime ge ${opts.since}`)}&$orderby=receivedDateTime%20asc&` : "$orderby=receivedDateTime%20desc&"}$top=${top}&${select}`;
    while (next && messages.length < top) {
      const page: { value: any[]; "@odata.nextLink"?: string } = await this.json(next); calls += 1;
      messages.push(...(page.value || []).map((m) => this.toMessage(mailbox, m)));
      next = page["@odata.nextLink"] || null;
    }
    return { messages: messages.slice(0, top), calls };
  }
  async getMessage(mailbox: string, id: string) {
    const m: any = await this.json(`/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(id)}?$select=id,subject,from,toRecipients,receivedDateTime,conversationId,internetMessageId,hasAttachments,bodyPreview,webLink,body`, { headers: { Prefer: 'outlook.body-content-type="text"' } });
    const body: MailBody = { id, text: String(m.body?.content || ""), html: null };
    return { ...this.toMessage(mailbox, m), body };
  }
  async listAttachments(mailbox: string, id: string): Promise<MailAttachment[]> {
    const r: { value: any[] } = await this.json(`/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(id)}/attachments?$select=id,name,contentType,size,isInline`);
    return (r.value || []).filter((a) => !a["@odata.type"] || a["@odata.type"] === "#microsoft.graph.fileAttachment").map((a) => ({ id: a.id, name: a.name || "attachment", contentType: (a.contentType || "").toLowerCase(), size: a.size || 0, isInline: !!a.isInline }));
  }
  async getAttachment(mailbox: string, id: string, attachmentId: string) {
    const r = await this.fetch(`/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/$value`);
    if (!r.ok) throw new FinanceError(`GRAPH_${r.status}`, r.status >= 500, 502);
    return new Uint8Array(await r.arrayBuffer());
  }
  private message(d: DraftInput) {
    return { subject: d.subject, body: { contentType: "HTML", content: d.html }, toRecipients: d.to.map((address) => ({ emailAddress: { address } })), ...(d.cc?.length ? { ccRecipients: d.cc.map((address) => ({ emailAddress: { address } })) } : {}), ...(d.attachments?.length ? { attachments: d.attachments.map((a) => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: a.name, contentType: a.contentType, contentBytes: a.contentBytes })) } : {}) };
  }
  async createDraft(mailbox: string, d: DraftInput): Promise<DraftResult> {
    const base = `/users/${encodeURIComponent(mailbox)}`;
    if (d.replyToMessageId) {
      const reply: any = await this.json(`${base}/messages/${encodeURIComponent(d.replyToMessageId)}/createReply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const existing = reply.body?.contentType?.toLowerCase() === "text" ? `<pre>${String(reply.body.content || "").replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch] as string))}</pre>` : String(reply.body?.content || "");
      const m = /<body[^>]*>/i.exec(existing);
      const content = m ? `${existing.slice(0, m.index + m[0].length)}${d.html}${existing.slice(m.index + m[0].length)}` : `${d.html}${existing}`;
      await this.json(`${base}/messages/${encodeURIComponent(reply.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: { contentType: "HTML", content }, ...(d.to.length ? { toRecipients: d.to.map((address) => ({ emailAddress: { address } })) } : {}) }) });
      return { id: reply.id, webLink: reply.webLink || null, mode: "draft" };
    }
    const draft: any = await this.json(`${base}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(this.message(d)) });
    return { id: draft.id, webLink: draft.webLink || null, mode: "draft" };
  }
  async send(mailbox: string, d: DraftInput): Promise<DraftResult> {
    await this.json(`/users/${encodeURIComponent(mailbox)}/sendMail`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: this.message(d), saveToSentItems: true }) });
    return { id: "sent", webLink: null, mode: "sent" };
  }
}
