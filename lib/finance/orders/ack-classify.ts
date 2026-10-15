// Pure, dependency-free classification helpers for supplier acknowledgement
// intake (PDF attachments and email bodies). Kept out of the intake module so
// they can be unit-tested without the mail provider or the store. Everything
// that used to be a hard-coded company fact (our own domain, our address on a
// purchase order) is now passed in from the connections config.

export const ACK_KEYWORDS = [
  "order acknowledgement", "order acknowledgment", "order confirmation", "confirmation of order", "sales order",
  "proforma", "pro-forma", "pro forma", "auftragsbestätigung", "auftragsbestatigung",
  "acknowledgement", "acknowledgment",
];
// Bare "acknowledgement" alone is weak evidence (invoices say "we acknowledge receipt").
export const WEAK_KEYWORDS = new Set(["acknowledgement", "acknowledgment"]);

export function looksLikeAck(text: string, subject: string | null, fileName: string): { ack: boolean; reason: string } {
  const hay = `${subject || ""}\n${fileName}\n${text}`.toLowerCase();
  const hits = ACK_KEYWORDS.filter((k) => hay.includes(k));
  if (!hits.length) return { ack: false, reason: "NO_ACK_KEYWORDS" };
  const strong = hits.filter((k) => !WEAK_KEYWORDS.has(k));
  const invoiceLike = /\b(tax\s+)?invoice\s+(no\.?|number|date)\b/i.test(text) || /\btax\s+point\b/i.test(text);
  if (!strong.length && invoiceLike) return { ack: false, reason: "LOOKS_LIKE_INVOICE" };
  if (/\b(delivery\s+note|despatch\s+note|dispatch\s+note|packing\s+list)\b/i.test(`${subject || ""} ${fileName}`) && !strong.length) return { ack: false, reason: "LOOKS_LIKE_DELIVERY_NOTE" };
  return { ack: true, reason: `ACK_KEYWORDS:${hits.slice(0, 3).join("|")}` };
}

export function findAckRef(text: string): string | null {
  const m = /(?:order\s+)?(?:acknowledgement|acknowledgment|confirmation|sales\s+order|auftragsbest[äa]tigung|ab)\s*(?:no\.?|number|nr\.?|#|ref(?:erence)?\.?)?\s*[:#.-]?\s*([A-Z0-9][A-Z0-9\/-]{3,24})\b/i.exec(text);
  if (!m) return null;
  const ref = m[1].toUpperCase();
  if (/^(DATE|NUMBER|NO|REF|ORDER|FROM|OUR|YOUR|CUSTOMER)$/.test(ref)) return null;
  return ref;
}

export function findExpectedDate(text: string): string | null {
  const m = /\b(?:delivery|despatch|dispatch|expected|ship(?:ping)?|lieferwoche|liefertermin)\s*(?:date|week|wk|kw|termin)?\s*[:.-]?\s*(?:(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})|(?:week|wk|kw)\s*(\d{1,2})(?:[\/.\-\s]*(\d{4}))?)/i.exec(text);
  if (!m) return null;
  if (m[1]) {
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10); let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 2020 && y <= 2100) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return null;
  }
  if (m[4]) return `week ${m[4]}${m[5] ? ` ${m[5]}` : ""}`;
  return null;
}

// PO-YYYY-XXXXX as the CRM writes it; tolerate space / underscore separators.
// A longer display reference ("PO-2026-K3M9Q · SMITH · AB1 2CD · Pos 1, 2…")
// starts with the same key, so it matches too; "Pos 1" cannot.
export function findPoReferences(hay: string): string[] {
  const out = new Set<string>();
  const re = /\bPO[-\s_]?(\d{4})[-\s_]?([A-Z0-9]{3,8})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(hay))) out.add(`PO-${m[1]}-${m[2].toUpperCase()}`);
  return Array.from(out);
}

const senderDomain = (from: string | null | undefined) => (from || "").trim().toLowerCase().split("@")[1] || "";

// Our own people: anyone on one of the company's internal domains.
export const isInternalSender = (from: string | null | undefined, internalDomains: Iterable<string>) => {
  const d = senderDomain(from);
  if (!d) return false;
  for (const x of internalDomains) if (x.trim().toLowerCase() === d) return true;
  return false;
};

export const isAutoReply = (subject: string | null | undefined, from: string | null | undefined) =>
  /^(automatic reply|auto(matic)?[- ]?reply|out of office|undeliverable|delivery (status )?notification|read:|recall:|accepted:|declined:|tentative:)/i.test((subject || "").trim()) ||
  /^(no-?reply|noreply|mailer-daemon|postmaster|donotreply|do-not-reply)@/i.test((from || "").trim());

// Keep only the supplier's own words: cut the quoted tail of a reply.
export function stripQuotedReply(text: string): string {
  const cut = text.search(/^(On .{5,160} wrote:|From: .+|-{3,} ?Original Message ?-{3,}|_{10,}|Sent from my .+|> ?Dear .+)$/m);
  return cut > 0 ? text.slice(0, cut) : text;
}

export const hasMoneyToken = (text: string) => /£\s?\d|\b\d{1,3}(,\d{3})*\.\d{2}\b|\bGBP\b|\bEUR\b|€\s?\d/.test(text);

// Cheap pre-filter from the mailbox listing alone (sender + subject + preview),
// so no mail call is spent on obvious non-acknowledgements. Our own sent copies
// (the orders mailbox is usually CC'd on every PO), colleagues' chatter and
// auto-replies are out; a known supplier sender, or a PO reference in the
// subject/preview, is in.
export function bodyAckCandidate(
  m: { from: string | null; subject: string | null; preview: string | null },
  supplierDomains: Set<string>,
  supplierEmails: Set<string>,
  internalDomains: Iterable<string> = [],
): { candidate: boolean; reason: string } {
  if (isInternalSender(m.from, internalDomains)) return { candidate: false, reason: "INTERNAL_SENDER" };
  if (isAutoReply(m.subject, m.from)) return { candidate: false, reason: "AUTO_REPLY" };
  const from = (m.from || "").toLowerCase();
  const domain = senderDomain(from);
  const known = (!!from && supplierEmails.has(from)) || (!!domain && supplierDomains.has(domain));
  const hay = `${m.subject || ""}\n${m.preview || ""}`;
  const hasRef = findPoReferences(hay).length > 0;
  if (!known && !hasRef) return { candidate: false, reason: "UNKNOWN_SENDER_NO_PO_REF" };
  const cls = looksLikeAck(m.preview || "", m.subject, "");
  if (cls.ack || hasRef) return { candidate: true, reason: known ? (hasRef ? "SUPPLIER_SENDER+PO_REF" : "SUPPLIER_SENDER") : "PO_REF_IN_SUBJECT" };
  return { candidate: false, reason: cls.reason };
}

// Our own purchase-order PDF (the copy CC'd to the orders mailbox) — never an
// ack. Recognised by the PO file name, the words PURCHASE ORDER and one of the
// company's own markers in the text (company name, internal domain). Without
// any marker configured nothing is treated as our own copy — a supplier's
// acknowledgement must never be thrown away on a guess.
export function isOwnPoCopy(fileName: string | null | undefined, text: string, markers: string[] = []): boolean {
  const name = (fileName || "").trim();
  if (!/^PO-\d{4}-[A-Z0-9]{3,8}\.pdf$/i.test(name) || !/PURCHASE ORDER/.test(text)) return false;
  const marks = markers.map((m) => (m || "").trim().toLowerCase()).filter((m) => m.length >= 3);
  if (!marks.length) return false;
  const lower = text.toLowerCase();
  return marks.some((m) => lower.includes(m));
}
