// Mail provider abstraction: the intake, orders and accounts agents read and
// draft through this surface, never through Graph or IMAP directly.
export interface MailMessage {
  id: string;
  mailbox: string;
  subject: string | null;
  from: { address: string | null; name: string | null };
  to: string[];
  receivedAt: string;          // ISO date-time
  conversationId: string | null;
  internetMessageId: string | null;
  hasAttachments: boolean;
  preview: string | null;
  webLink?: string | null;
}
export interface MailAttachment { id: string; name: string; contentType: string; size: number; isInline: boolean }
export interface MailBody { id: string; text: string; html: string | null }
export interface DraftInput {
  to: string[]; cc?: string[]; subject: string; html: string;
  attachments?: { name: string; contentType: string; contentBytes: string }[];
  replyToMessageId?: string | null;
}
export interface DraftResult { id: string; webLink: string | null; mode: "draft" | "sent" }

export interface MailProvider {
  kind: "graph" | "imap";
  // Can this identity see the mailbox at all?
  probe(mailbox: string): Promise<{ ok: boolean; error?: string }>;
  listMessages(mailbox: string, opts: { folder?: string; since?: string; top?: number; search?: string }): Promise<{ messages: MailMessage[]; calls: number }>;
  getMessage(mailbox: string, id: string): Promise<MailMessage & { body: MailBody }>;
  listAttachments(mailbox: string, id: string): Promise<MailAttachment[]>;
  getAttachment(mailbox: string, id: string, attachmentId: string): Promise<Uint8Array>;
  createDraft(mailbox: string, draft: DraftInput): Promise<DraftResult>;
  send(mailbox: string, draft: DraftInput): Promise<DraftResult>;
}
