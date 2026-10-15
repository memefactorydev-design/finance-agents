// Orders module: classification helpers, extraction parsing, order ↔ ack
// comparison and the end-to-end intake run against an in-memory store, a
// fake mail provider and a fake extractor. Run with `npm test`.
//
// One outer test imports the modules after pointing evidence custody at a
// scratch directory (the project compiles to CommonJS, so no top-level
// await); the cases run as sequential subtests sharing that state.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type OrderLine = import("../lib/crm/types").OrderLine;
type AckLine = import("../lib/crm/types").AckLine;
type SupplierOrder = import("../lib/crm/types").SupplierOrder;
type MailMessage = import("../lib/mail/types").MailMessage;
type MailProvider = import("../lib/mail/types").MailProvider;
type AckExtraction = import("../lib/finance/orders/ack-extraction").AckExtraction;

test("orders module", async (t) => {
// Evidence bytes go to a scratch directory; the store is in memory.
process.env.FINANCE_DATA_DIR = mkdtempSync(join(tmpdir(), "finance-agents-orders-"));
delete process.env.DATABASE_URL;

const { bodyAckCandidate, findPoReferences, isAutoReply, isInternalSender, isOwnPoCopy, looksLikeAck, stripQuotedReply, hasMoneyToken, findAckRef, findExpectedDate } = await import("../lib/finance/orders/ack-classify");
const { parseAckExtraction, redactBankDetails, ackExtractionSchema } = await import("../lib/finance/orders/ack-extraction");
const { pairOrderAndAck, compareOrderToAck, ackTotals, buildAck, supplierCostFor, positionLabel, discrepancySummary } = await import("../lib/finance/orders/ack-apply");
const { MemoryStore } = await import("../lib/core/store");
const { setStoreForTests } = await import("../lib/core/server");
const { defaultConnections } = await import("../lib/core/config");
const { upsertProject, getProject, listProjectNotes } = await import("../lib/crm/projects");
const { upsertSupplierProfile } = await import("../lib/finance/suppliers");
const { listBriefs } = await import("../lib/finance/briefs");
const { runOrdersIntakeJob, listOrderAcks, matchOrderAck, rejectOrderAck, ordersIntakeHealth, openOrdersForMatching, readOrderAckEvidence } = await import("../lib/finance/orders/orders-intake");
const { ordersJob } = await import("../lib/finance/orders/jobs");
const sub = (name: string, fn: (t: TestContext) => void | Promise<void>) => t.test(name, fn);

const internal = new Set(["example.com"]);
const domains = new Set(["acme-worktops.example", "uniform-doors.example"]);
const emails = new Set(["orders@andover-appliances.example"]);

// ----------------------------------------------------------- classification
await sub("stripQuotedReply keeps the supplier's words and drops the quoted PO email", () => {
  const body = "Hi,\nOrder confirmed, ref SO-4411, delivery week 43.\nCarriage £45.00\n\nOn Mon, 6 Oct 2026 at 10:12, Acme Kitchens <sales@example.com> wrote:\n> Please find attached purchase order PO-2026-K3M9Q";
  const out = stripQuotedReply(body);
  assert.match(out, /SO-4411/);
  assert.doesNotMatch(out, /purchase order PO-2026/);
  assert.equal(stripQuotedReply("From: Tom\nhello"), "From: Tom\nhello"); // cut only when there is text before the quote
});

await sub("auto-replies and internal senders are never body candidates", () => {
  assert.equal(isInternalSender("sales@example.com", internal), true);
  assert.equal(isInternalSender("tom@acme-worktops.example", internal), false);
  assert.equal(isInternalSender("tom@acme-worktops.example", []), false);
  assert.equal(isAutoReply("Automatic reply: Purchase Order PO-2026-K3M9Q", "tom@acme-worktops.example"), true);
  assert.equal(isAutoReply("RE: Purchase Order", "noreply@acme-worktops.example"), true);
  assert.equal(bodyAckCandidate({ from: "sales@example.com", subject: "Purchase Order PO-2026-K3M9Q", preview: "order acknowledgement" }, domains, emails, internal).reason, "INTERNAL_SENDER");
  assert.equal(bodyAckCandidate({ from: "tom@acme-worktops.example", subject: "Automatic reply: PO-2026-K3M9Q", preview: "" }, domains, emails, internal).reason, "AUTO_REPLY");
});

await sub("body candidates: supplier sender with ack words, or a PO reference from anyone", () => {
  assert.equal(bodyAckCandidate({ from: "tom@acme-worktops.example", subject: "RE: Purchase Order PO-2026-K3M9Q · SMITH · AB1 2CD", preview: "Order acknowledgement below" }, domains, emails, internal).candidate, true);
  assert.equal(bodyAckCandidate({ from: "orders@andover-appliances.example", subject: "Your order", preview: "Sales order confirmation" }, domains, emails, internal).reason, "SUPPLIER_SENDER");
  assert.equal(bodyAckCandidate({ from: "someone@newsupplier.example", subject: "Your order", preview: "Sales order confirmation" }, domains, emails, internal).reason, "UNKNOWN_SENDER_NO_PO_REF");
  assert.equal(bodyAckCandidate({ from: "someone@newsupplier.example", subject: "Confirmation PO-2026-K3M9Q", preview: "" }, domains, emails, internal).reason, "PO_REF_IN_SUBJECT");
  assert.equal(bodyAckCandidate({ from: "tom@acme-worktops.example", subject: "Lunch?", preview: "fancy a pint" }, domains, emails, internal).candidate, false);
});

await sub("PO references are found inside the full display reference but 'Pos 1' never matches", () => {
  assert.deepEqual(findPoReferences("RE: Purchase Order PO-2026-K3M9Q · SMITH · AB1 2CD · Pos 1, 2, 3.1"), ["PO-2026-K3M9Q"]);
  assert.deepEqual(findPoReferences("po 2026 k3m9q and PO_2026_ABC12"), ["PO-2026-K3M9Q", "PO-2026-ABC12"]);
  assert.deepEqual(findPoReferences("Pos 1, 2, 3 and position 4"), []);
});

await sub("our own PO copy, invoices and delivery notes are not acknowledgements; money token check", () => {
  const markers = ["Acme Kitchens", "example.com"];
  assert.equal(isOwnPoCopy("PO-2026-K3M9Q.pdf", "Acme Kitchens PURCHASE ORDER 1 High Street", markers), true);
  assert.equal(isOwnPoCopy("PO-2026-K3M9Q.pdf", "Acme Kitchens PURCHASE ORDER 1 High Street", []), false); // no marker → never a guess
  assert.equal(isOwnPoCopy("SO-4411.pdf", "ORDER ACKNOWLEDGEMENT Acme Kitchens", markers), false);
  assert.equal(looksLikeAck("Tax invoice number 1001 tax point 1/10/2026 — acknowledgement of receipt", null, "inv.pdf").reason, "LOOKS_LIKE_INVOICE");
  assert.equal(looksLikeAck("acknowledgement of goods received", "Delivery note 55", "dn.pdf").reason, "LOOKS_LIKE_DELIVERY_NOTE");
  assert.equal(looksLikeAck("Order acknowledgement SO-4411", "RE: PO", "ack.pdf").ack, true);
  assert.equal(looksLikeAck("thanks for your order", null, "x.pdf").reason, "NO_ACK_KEYWORDS");
  assert.equal(hasMoneyToken("Carriage £45.00"), true);
  assert.equal(hasMoneyToken("thanks, received"), false);
});

await sub("findAckRef / findExpectedDate read the supplier's own reference and dates", () => {
  assert.equal(findAckRef("ORDER ACKNOWLEDGEMENT No: SO-4411 Date 01/10/2026"), "SO-4411");
  assert.equal(findAckRef("Acknowledgement date 01/10/2026"), null);
  assert.equal(findExpectedDate("Delivery date: 20/10/2026"), "2026-10-20");
  assert.equal(findExpectedDate("Lieferwoche KW 43 2026"), "week 43 2026");
  assert.equal(findExpectedDate("no dates here"), null);
});

// ---------------------------------------------------------------- extraction
await sub("parseAckExtraction accepts the full object and the old bare array; zod shape holds", () => {
  const full = parseAckExtraction('Here you go {"supplierRef":"SO-4411","expectedDate":"2026-10-20","currency":"gbp","lines":[{"position":"5","code":"P6045WA","description":"Wall unit","qty":"1","unitCost":"£128.18","lineTotal":128.18}],"extras":[{"label":"Carriage","amount":45},{"label":"Discount","amount":-10.5}],"subtotal":128.18,"vat":25.64,"total":162.68}');
  assert.equal(full.supplierRef, "SO-4411");
  assert.equal(full.currency, "GBP");
  assert.equal(full.lines[0].position, "5");
  assert.equal(full.lines[0].unitCost, 128.18);
  assert.deepEqual(full.extras, [{ label: "Carriage", amount: 45 }, { label: "Discount", amount: -10.5 }]);
  assert.equal(full.total, 162.68);
  assert.ok(ackExtractionSchema.safeParse(full).success);
  const legacy = parseAckExtraction('[{"code":"A","qty":2,"unitCost":3}]');
  assert.equal(legacy.lines.length, 1);
  assert.equal(legacy.total, null);
  assert.equal(parseAckExtraction("nonsense").lines.length, 0);
});

await sub("bank details are redacted before any model call", () => {
  const out = redactBankDetails("Pay to sort code 40-11-22 account number 12345678 IBAN GB29NWBK60161331926819 total £10.00");
  assert.doesNotMatch(out, /40-11-22|12345678|GB29NWBK/);
  assert.match(out, /£10\.00/);
});

// ----------------------------------------------------------------- comparing
const po = (over: Partial<SupplierOrder> = {}): SupplierOrder => ({
  id: "O-1", reference: "PO-2026-K3M9Q", supplierId: "V-ACME", supplierName: "Acme Worktops", status: "sent", orderType: "contract",
  lines: [
    { code: "P6045WA", description: "Wall unit", qty: 1, unitCost: 128.18, position: 5 },
    { code: "99PUSH", description: "Push open", qty: 1, unitCost: 9.86, position: 5, subPosition: 1 },
    { code: "99PUSH", description: "Push open", qty: 1, unitCost: 9.86, position: 21, subPosition: 1 },
    { code: "99PUSH", description: "Push open", qty: 1, unitCost: 9.86, position: 23, subPosition: 1 },
    { code: "", description: "Quartz worktops as per plan", qty: 1, unitCost: 2000, position: 58 },
  ],
  sentAt: "2026-10-06T10:00:00Z", createdAt: "2026-10-06T10:00:00Z", updatedAt: "2026-10-06T10:00:00Z",
  ...over,
});

await sub("positionLabel", () => {
  assert.equal(positionLabel({ position: 4, subPosition: 1 }), "4.1");
  assert.equal(positionLabel({ position: 4, subPosition: 0 }), "4");
  assert.equal(positionLabel({}), "");
});

await sub("pairOrderAndAck: positions first, then codes as aggregates, code-less lines by description", () => {
  const o = po();
  const ack: AckLine[] = [
    { code: "P6045WA", description: "Wall unit", qty: 1, unitCost: 128.18, position: "5" },
    { code: "99PUSH", description: "Push open x3", qty: 3, unitCost: 9.86 },
    { code: "", description: "Quartz worktops as per plan", qty: 1, unitCost: 2000 },
    { code: "CARR", description: "Carriage", qty: 1, unitCost: 45 },
  ];
  const p = pairOrderAndAck(o.lines, ack);
  assert.equal(p.pairs.length, 2); // position 5 + the worktop by description
  assert.equal(p.groups.length, 1);
  assert.equal(p.groups[0].order.length, 3);
  assert.equal(p.missing.length, 0);
  assert.deepEqual(p.extra.map((a) => a.code), ["CARR"]);
});

await sub("compareOrderToAck: consolidated duplicates match; qty/price deltas carry positions and £ effect; extras and totals flagged", () => {
  const o = po();
  const match = compareOrderToAck(o.lines, [
    { code: "P6045WA", qty: 1, unitCost: 128.18 },
    { code: "99PUSH", qty: 3, unitCost: 9.86 },
    { code: "", description: "Quartz worktops as per plan", qty: 1, unitCost: 2000 },
  ]);
  assert.equal(match.status, "match");

  const diff = compareOrderToAck(o.lines, [
    { code: "P6045WA", qty: 1, unitCost: 135.0, position: "5" },
    { code: "99PUSH", qty: 2, unitCost: 9.86 },
  ], { extras: [{ label: "Carriage", amount: 45 }], total: 9999 });
  assert.equal(diff.status, "discrepancy");
  const price = diff.discrepancies.find((d) => d.field === "unitCost")!;
  assert.equal(price.position, "5");
  assert.equal(price.delta, 6.82);
  const qty = diff.discrepancies.find((d) => d.field === "qty")!;
  assert.equal(qty.position, "5.1, 21.1, 23.1");
  assert.equal(qty.ordered, "3");
  assert.equal(qty.acknowledged, "2");
  assert.ok(diff.discrepancies.some((d) => d.field === "missing_from_ack" && d.position === "58"));
  assert.ok(diff.discrepancies.some((d) => d.field === "extra_charge" && d.lineCode === "Carriage" && d.delta === 45));
  assert.ok(diff.discrepancies.some((d) => d.field === "total"));
  assert.match(discrepancySummary(diff.discrepancies), /^5 differences: Pos 5 P6045WA price 128\.18 → 135\.00; /);
});

await sub("ackTotals follows the rule: supplier prices for paired lines, ordered price for unacknowledged, plus extras", () => {
  const o = po({
    ack: {
      receivedAt: "2026-10-07T09:00:00Z", status: "discrepancy", discrepancies: [],
      lines: [
        { code: "P6045WA", qty: 1, unitCost: 135.0, position: "5" }, // +6.82
        { code: "99PUSH", qty: 2, unitCost: 9.86 }, // 2 of 3 → 19.72 (ordered 29.58)
        // worktop (2000) missing → counted at ordered price
      ],
      extras: [{ label: "Carriage", amount: 45 }],
    },
  });
  const t = ackTotals(o);
  assert.equal(t.orderedCost, 2157.76);
  assert.equal(t.unacknowledgedCost, 2000);
  assert.equal(t.extrasTotal, 45);
  assert.equal(t.acknowledgedCost, 135 + 19.72 + 2000 + 45);
  assert.equal(t.delta, Math.round((t.acknowledgedCost - 2157.76) * 100) / 100);
  assert.deepEqual(t.coverage, { matched: 4, missing: 1, extra: 0, total: 5 });
  assert.equal(ackTotals(po()).acknowledgedCost, 2157.76);
  assert.equal(ackTotals(po({ orderedNet: 2100 })).orderedCost, 2100); // a CRM-given total wins
});

await sub("buildAck + supplierCostFor", () => {
  const o = po();
  const { ack, totals, status } = buildAck(o, {
    lines: [{ code: "P6045WA", qty: 1, unitCost: 128.18 }, { code: "99PUSH", qty: 3, unitCost: 9.86 }, { code: "", description: "Quartz worktops as per plan", qty: 1, unitCost: 2000 }],
    extras: [{ label: "Pallet", amount: 12 }], supplierRef: "ACK-77", expectedDate: "2026-11-02",
  }, { extractedBy: "ai", source: "body", mailbox: "orders@example.com", messageId: "m1", by: "tester", how: "test" });
  assert.equal(status, "discrepancy"); // the pallet charge
  assert.equal(ack.status, "discrepancy");
  assert.equal(ack.supplierRef, "ACK-77");
  assert.equal(ack.expectedDate, "2026-11-02");
  assert.equal(ack.appliedBy, "tester");
  assert.equal(totals.acknowledgedCost, 2157.76 + 12);
  assert.deepEqual(supplierCostFor({ ...o, ack }), { cost: 2157.76 + 12, basis: "acknowledged" });
  assert.deepEqual(supplierCostFor(o), { cost: 2157.76, basis: "ordered" });
});

// ------------------------------------------------------------- intake run
type FakeMail = MailMessage & { text: string };
function fakeProvider(messages: FakeMail[], calls = { n: 0 }): MailProvider {
  const strip = ({ text: _t, ...m }: FakeMail): MailMessage => m;
  const find = (id: string) => { const m = messages.find((x) => x.id === id); if (!m) throw new Error("no such message"); return m; };
  return {
    kind: "imap",
    probe: async () => { calls.n += 1; return { ok: true }; },
    listMessages: async (mailbox, opts) => ({ messages: messages.filter((m) => m.mailbox === mailbox && (!opts.since || m.receivedAt >= opts.since)).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).slice(0, opts.top ?? 50).map(strip), calls: 1 }),
    getMessage: async (_mailbox, id) => { const m = find(id); return { ...strip(m), body: { id, text: m.text, html: null } }; },
    listAttachments: async () => [],
    getAttachment: async () => { throw new Error("no attachments in this fake"); },
    createDraft: async () => { throw new Error("not used"); },
    send: async () => { throw new Error("not used"); },
  };
}
const mail = (over: Partial<FakeMail> & { id: string; receivedAt: string; text: string }): FakeMail => ({
  mailbox: "orders@example.com", subject: null, from: { address: null, name: null }, to: ["orders@example.com"], conversationId: null, internetMessageId: `<${over.id}@mail.example>`, hasAttachments: false, preview: over.text.slice(0, 120), ...over,
});

const cfg = defaultConnections();
cfg.company.name = "Acme Kitchens";
cfg.company.internalDomains = ["example.com"];
cfg.mail.ordersMailboxes = ["orders@example.com"];
cfg.intake.ordersEnabled = true;

const ackLines: AckLine[] = [
  { code: "P6045WA", description: "Wall unit", qty: 1, unitCost: 128.18, position: "5" },
  { code: "99PUSH", description: "Push open", qty: 3, unitCost: 9.86 },
  { code: "", description: "Quartz worktops as per plan", qty: 1, unitCost: 2000 },
];
const extraction = (over: Partial<AckExtraction> = {}): AckExtraction => ({ supplierRef: "SO-4411", expectedDate: "2026-10-20", currency: "GBP", lines: ackLines, extras: [{ label: "Carriage", amount: 45 }], subtotal: 2157.76, vat: null, total: 2202.76, ...over });

{
  setStoreForTests(new MemoryStore());
  await upsertSupplierProfile("V-ACME", { vendorName: "Acme Worktops", emailDomains: ["acme-worktops.example"], contacts: [{ name: "Orders desk", email: "orders@acme-worktops.example" }] }, "test");
  await upsertSupplierProfile("V-UNI", { vendorName: "Uniform Doors", emailDomains: ["uniform-doors.example"] }, "test");
  const lines: OrderLine[] = po().lines;
  await upsertProject({ id: "P-SMITH", firstName: "Jane", lastName: "Smith", postcode: "AB1 2CD", status: "active", wonDate: "2026-09-01", wonValue: 20000, supplierOrders: [
    po({ id: "O-1", reference: "PO-2026-K3M9Q", lines }),
    po({ id: "O-2", reference: "PO-2026-UNI01", supplierId: "V-UNI", supplierName: "Uniform Doors", lines: [{ code: "DOOR-1", description: "Door", qty: 2, unitCost: 50 }] }),
    po({ id: "O-3", reference: "PO-2026-UNI02", supplierId: "V-UNI", supplierName: "Uniform Doors", status: "sent", lines: [{ code: "DOOR-2", description: "Door", qty: 1, unitCost: 70 }] }),
  ] }, "test");
  await upsertProject({ id: "P-JONES", firstName: "Bob", lastName: "Jones", postcode: "ZZ9 9ZZ", status: "active", wonDate: "2026-09-02", wonValue: 9000, supplierOrders: [
    po({ id: "O-4", reference: "PO-2026-CONF1", status: "confirmed", lines, ack: { receivedAt: "2026-09-10T00:00:00Z", status: "match", discrepancies: [], lines: ackLines } }),
  ] }, "test");
}

await sub("intake: a supplier's email body with the PO reference is matched, applied to the order, noted and briefed", async () => {
  const messages: FakeMail[] = [
    mail({ id: "m1", receivedAt: "2026-10-07T09:00:00Z", from: { address: "tom@acme-worktops.example", name: "Tom" }, subject: "RE: Purchase Order PO-2026-K3M9Q · SMITH · AB1 2CD", text: "Hi,\nOrder acknowledgement SO-4411 for Smith.\nDelivery date: 20/10/2026\n1 x P6045WA £128.18\n3 x 99PUSH £9.86\nCarriage £45.00\n\nOn Mon, 6 Oct 2026 at 10:12, Acme Kitchens <sales@example.com> wrote:\n> PO attached" }),
    mail({ id: "m2", receivedAt: "2026-10-07T09:05:00Z", from: { address: "sales@example.com", name: "Sales" }, subject: "FW: Purchase Order PO-2026-K3M9Q", text: "internal chatter order acknowledgement £1.00" }),
    mail({ id: "m3", receivedAt: "2026-10-07T09:06:00Z", from: { address: "someone@newsupplier.example", name: "X" }, subject: "Your order", text: "Sales order confirmation £10.00" }),
  ];
  let extracted = 0;
  const run = await runOrdersIntakeJob({ by: "test-run" }, { cfg, provider: fakeProvider(messages), extract: async () => { extracted += 1; return extraction(); } });
  assert.equal(run.ok, true, run.error);
  assert.equal(run.skipped, undefined);
  assert.equal(run.scanned, 3);
  assert.equal(run.bodies, 1); // only the supplier's reply cost a mail call
  assert.equal(extracted, 1);
  assert.equal(run.created, 1);
  assert.equal(run.matched, 1);
  assert.equal(run.items[0].order, "PO-2026-K3M9Q");
  assert.equal(run.items[0].kind, "body");
  assert.ok(run.items[0].reasons[0].startsWith("DIFFERENCES:1"), run.items[0].reasons.join(","));
  assert.ok(run.items[0].reasons.includes("BODY:SUPPLIER_SENDER+PO_REF"));
  assert.equal(run.watermark, "2026-10-07T09:06:00Z");
  assert.ok(run.mailCalls >= 2);

  const [rec] = await listOrderAcks({ state: "matched" });
  assert.equal(rec.supplier.source, "domain");
  assert.equal(rec.order.source, "reference");
  assert.equal(rec.order.projectId, "P-SMITH");
  assert.equal(rec.order.projectName, "Jane Smith");
  assert.equal(rec.extraction?.acknowledgementRef, "SO-4411");
  assert.equal(rec.ack?.status, "discrepancy");
  assert.equal(rec.ack?.supplierCost, 2157.76 + 45);
  assert.equal(rec.ack?.orderedCost, 2157.76);

  const project = (await getProject("P-SMITH"))!;
  const order = project.supplierOrders!.find((o) => o.id === "O-1")!;
  assert.equal(order.status, "discrepancy");
  assert.equal(order.ack?.supplierRef, "SO-4411");
  assert.equal(order.ack?.expectedDate, "2026-10-20");
  assert.equal(order.ack?.source, "body");
  assert.equal(order.ack?.mailbox, "orders@example.com");
  assert.equal(order.ack?.appliedBy, "test-run");
  assert.deepEqual(order.ack?.discrepancies.map((d) => d.field), ["extra_charge"]);
  const notes = await listProjectNotes("P-SMITH");
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /has differences — PO-2026-K3M9Q: Acme Worktops \(their ref SO-4411\)/);
  const briefs = await listBriefs({ author: "test-run" });
  assert.equal(briefs.length, 1);
  assert.match(briefs[0].text, /1 difference: Carriage £45\.00/);
  assert.equal(briefs[0].meta?.orderId, "O-1");

  const evidence = await readOrderAckEvidence(rec.sha256);
  assert.equal(evidence?.contentType, "text/plain");
  assert.match(Buffer.from(evidence!.bytes).toString(), /SO-4411/);
  assert.doesNotMatch(Buffer.from(evidence!.bytes).toString(), /PO attached/); // the quoted tail was cut

  const health = await ordersIntakeHealth(cfg);
  assert.equal(health.ok, true);
  assert.equal(health.watermark, "2026-10-07T09:06:00Z");
  assert.equal(health.mailboxes.length, 1);

  // Second run: nothing new, nothing re-processed.
  const again = await runOrdersIntakeJob({}, { cfg, provider: fakeProvider(messages), extract: async () => extraction() });
  assert.equal(again.scanned, 0);
  assert.equal(again.created + again.arrivals, 0);
  assert.equal((await listOrderAcks({ state: "all" })).length, 1);
});

await sub("intake: the same acknowledgement sent again is a duplicate; a revision replaces it", async () => {
  const dup = mail({ id: "m4", receivedAt: "2026-10-08T09:00:00Z", from: { address: "tom@acme-worktops.example", name: "Tom" }, subject: "RE: Purchase Order PO-2026-K3M9Q", text: "Order acknowledgement SO-4411 again £45.00" });
  const r1 = await runOrdersIntakeJob({}, { cfg, provider: fakeProvider([dup]), extract: async () => extraction() });
  assert.equal(r1.duplicate, 1);
  assert.ok(r1.items[0].reasons[0].startsWith("DUPLICATE_ACK_ON:PO-2026-K3M9Q"));

  const revised = mail({ id: "m5", receivedAt: "2026-10-09T09:00:00Z", from: { address: "tom@acme-worktops.example", name: "Tom" }, subject: "RE: Purchase Order PO-2026-K3M9Q", text: "Revised order acknowledgement SO-4411 £0.00" });
  const r2 = await runOrdersIntakeJob({}, { cfg, provider: fakeProvider([revised]), extract: async () => extraction({ extras: [], total: 2157.76 }) });
  assert.equal(r2.matched, 1);
  const rec = (await listOrderAcks({ state: "matched" })).find((r) => r.arrivals[0].messageId === "m5")!;
  assert.ok(rec.reasons.includes("ACK_REVISED:replaces the acknowledgement already on the order"));
  assert.equal(rec.ack?.status, "match");
  const order = (await getProject("P-SMITH"))!.supplierOrders!.find((o) => o.id === "O-1")!;
  assert.equal(order.status, "acknowledged");
  assert.deepEqual(order.ack?.extras, []);
});

await sub("intake: a confirmed order is never overwritten; an ambiguous supplier reply waits for a human", async () => {
  const confirmed = mail({ id: "m6", receivedAt: "2026-10-10T09:00:00Z", from: { address: "tom@acme-worktops.example", name: "Tom" }, subject: "Confirmation PO-2026-CONF1", text: "Order acknowledgement SO-9 £1.00" });
  const r = await runOrdersIntakeJob({}, { cfg, provider: fakeProvider([confirmed]), extract: async () => extraction() });
  assert.equal(r.unmatched, 1);
  const rec = (await listOrderAcks({ state: "open" })).find((x) => x.arrivals[0].messageId === "m6")!;
  assert.ok(rec.reasons.some((x) => x.startsWith("ORDER_ALREADY_CONFIRMED:PO-2026-CONF1")));
  assert.equal(rec.order.id, null);
  assert.equal(rec.order.reference, "PO-2026-CONF1");

  // Two open Uniform Doors orders for the same customer, no reference, no surname → ambiguous.
  const vague = mail({ id: "m7", receivedAt: "2026-10-10T10:00:00Z", from: { address: "desk@uniform-doors.example", name: "Desk" }, subject: "Order confirmation", text: "Sales order confirmation 2 x DOOR-1 £50.00" });
  const r2 = await runOrdersIntakeJob({}, { cfg, provider: fakeProvider([vague]), extract: async () => extraction({ lines: [{ code: "DOOR-1", qty: 2, unitCost: 50 }], extras: [], total: null, subtotal: null }) });
  assert.equal(r2.unmatched, 1);
  const open = (await listOrderAcks({ state: "open" })).find((x) => x.arrivals[0].messageId === "m7")!;
  assert.equal(open.supplier.id, "V-UNI");
  assert.ok(open.reasons.some((x) => x === "OPEN_ORDERS_AMBIGUOUS:PO-2026-UNI01|PO-2026-UNI02"), open.reasons.join(","));

  // A human (or agent) matches it; then it cannot be rejected.
  const matched = await matchOrderAck(open.sha256, "O-2", "Reviewer (agent)", { extract: async () => extraction() });
  assert.equal(matched.state, "matched");
  assert.equal(matched.order.source, "manual");
  assert.equal(matched.order.projectId, "P-SMITH");
  assert.equal(matched.ack?.status, "match");
  assert.equal(matched.reasons[0], "MATCHED_BY:Reviewer (agent)");
  await assert.rejects(rejectOrderAck(open.sha256, "wrong", "x"), /ORDERACK_ALREADY_MATCHED/);
  const rejected = await rejectOrderAck(rec.sha256, "superseded", "Reviewer");
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.reasons[0], "REJECTED:superseded");
  await assert.rejects(matchOrderAck("0".repeat(64), "O-2", "x"), /ORDERACK_NOT_FOUND/);
  await assert.rejects(matchOrderAck(rec.sha256, "O-404", "x"), /ORDER_NOT_FOUND/);
});

await sub("intake: not-an-ack bodies are kept as not_ack; open orders for matching; gates", async () => {
  const stmt = mail({ id: "m8", receivedAt: "2026-10-11T09:00:00Z", from: { address: "orders@acme-worktops.example", name: "Acme" }, subject: "Statement of account", text: "Statement — balance £120.00" });
  const chat = mail({ id: "m9", receivedAt: "2026-10-11T09:30:00Z", from: { address: "orders@acme-worktops.example", name: "Acme" }, subject: "Order acknowledgement to follow", text: "Thanks — the order acknowledgement will follow by post." });
  const r = await runOrdersIntakeJob({}, { cfg, provider: fakeProvider([stmt, chat]), extract: async () => { throw new Error("must not be called"); } });
  assert.equal(r.scanned, 2);
  assert.equal(r.bodies, 1); // the statement fails the listing pre-filter (no ack words); the known sender with ack words is fetched…
  assert.equal(r.notAck, 1); // …but a body without any prices is not an acknowledgement
  const rec = (await listOrderAcks({ state: "not_ack" }))[0];
  assert.equal(rec.arrivals[0].messageId, "m9");
  assert.ok(rec.reasons.includes("BODY_NO_PRICES"), rec.reasons.join(","));
  assert.equal(rec.supplier.source, "email");
  assert.equal(rec.supplier.id, "V-ACME");

  const open = await openOrdersForMatching();
  assert.deepEqual(open.map((o) => o.reference).sort(), ["PO-2026-K3M9Q", "PO-2026-UNI01", "PO-2026-UNI02"]);
  assert.deepEqual((await openOrdersForMatching("V-UNI")).map((o) => o.id).sort(), ["O-2", "O-3"]);

  const off = { ...cfg, intake: { ...cfg.intake, ordersEnabled: false } };
  assert.match((await runOrdersIntakeJob({}, { cfg: off, provider: fakeProvider([]) })).skipped || "", /switched off/);
  assert.equal((await runOrdersIntakeJob({ force: true }, { cfg: off, provider: fakeProvider([]) })).skipped, undefined);
  assert.match((await runOrdersIntakeJob({ mailbox: "other@example.com" }, { cfg, provider: fakeProvider([]) })).skipped || "", /not one of the orders mailboxes/);
  await assert.rejects(runOrdersIntakeJob({ since: "not a date" }, { cfg, provider: fakeProvider([]) }), /SINCE_INVALID/);
  assert.equal(typeof ordersJob, "function");
});
});
