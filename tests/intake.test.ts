// npx tsx --test tests/intake.test.ts
// Pure parts of supplier-invoice intake: the resolver (vendor, class, account,
// VAT, dates, terms, confidence), the learning loop (autopilot decision, class
// tokens, promotion streaks, shapes), the daily log (window, rows, totals,
// CSV) and the extractor's amount-null coercion. No I/O, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { QboRefData, TaxCodeConfig } from "../lib/qbo/client";
import type { SupplierProfile } from "../lib/finance/suppliers";
import type { ExtractedInvoice } from "../lib/finance/intake/extractor";
import { coerceAmountNulls } from "../lib/finance/intake/extractor";
import {
  resolveInvoice, scoreVendor, resolveClass, accountNameFor, itemFamilyAccount, ITEM_FAMILY_TABLE, DEFAULT_ACCOUNT,
  parseUkDate, dateSanity, termSpecFor, isOwnDocument, reasonText, projectOpen, matchLearnedClass, tokenAppears, type ResolveContext, type Resolution,
} from "../lib/finance/intake/resolve";
import {
  autopilotDecision, DEFAULT_AUTOPILOT, deriveClassTokens, projectForClass, promotionDue, codingShape, diffShapes, aggregateDecisions, normaliseAutopilotPatch,
  type AutopilotConfig, type AutopilotItem, type CodingDecision,
} from "../lib/finance/intake/learning";
import { csvField, intakeLogCsv, CSV_COLUMNS, logWindow, dayStart, rowsFromRecords, totalsFor, type IntakeLogRow } from "../lib/finance/intake/log-format";
import type { IntakeRecord } from "../lib/finance/intake/intake";

// ----------------------------------------------------------------- fixtures
const ref: QboRefData = {
  realm: "test", fetchedAt: Date.now(), customers: [],
  vendors: [
    { id: "v-acme", name: "Acme Appliances Ltd", email: "invoices@acme.example", termId: "t-eom", active: true },
    { id: "v-blue", name: "Bluewater UK", email: null, termId: "t-30", active: true },
    { id: "v-blue2", name: "Bluewater", email: null, termId: null, active: true },
    { id: "v-stone", name: "The Stone Group", email: "accounts@stonegroup.example", termId: null, active: true },
  ],
  accounts: [
    { id: "a-app", name: "Appliances", fullyQualifiedName: "Cost of Sales:Appliances", type: "Cost of Goods Sold", subType: null },
    { id: "a-work", name: "Worktops", fullyQualifiedName: "Worktops", type: "Cost of Goods Sold", subType: null },
    { id: "a-sink", name: "Sink and Taps", fullyQualifiedName: "Sink and Taps", type: "Cost of Goods Sold", subType: null },
    { id: "a-tiles", name: "Tiles", fullyQualifiedName: "Tiles", type: "Cost of Goods Sold", subType: null },
    { id: "a-del", name: "Delivery and Removals", fullyQualifiedName: "Delivery and Removals", type: "Expense", subType: null },
    { id: "a-inst", name: "Installation", fullyQualifiedName: "Installation", type: "Cost of Goods Sold", subType: null },
    { id: "a-rem", name: "Remedials", fullyQualifiedName: "Remedials", type: "Cost of Goods Sold", subType: null },
    { id: "a-add", name: "Additionals", fullyQualifiedName: "Additionals", type: "Cost of Goods Sold", subType: null },
    { id: "a-acc", name: "Purchase Accessories", fullyQualifiedName: "Purchase Accessories", type: "Cost of Goods Sold", subType: null },
    { id: "a-prod", name: "Products and Units", fullyQualifiedName: "Products and Units", type: "Cost of Goods Sold", subType: null },
  ],
  classes: [
    { id: "c-smith", name: "John Smith" }, { id: "c-patel", name: "Anita Patel" }, { id: "c-patel2", name: "Raj Patel" }, { id: "c-okonkwo", name: "Okonkwo" },
  ],
  taxCodes: [{ id: "tc-s", name: "20.0% S", rate: 20 }, { id: "tc-z", name: "0.0% Z", rate: 0 }, { id: "tc-e", name: "Exempt", rate: 0 }, { id: "tc-rc", name: "20.0% RC SG", rate: 20 }],
  terms: [{ id: "t-eom", name: "End of following month", type: "DATE_DRIVEN", dueDays: null, dayOfMonthDue: 31 }, { id: "t-30", name: "Net 30", type: "STANDARD", dueDays: 30, dayOfMonthDue: null }],
};
const taxCodes: TaxCodeConfig = { standard: "tc-s", zero: "tc-z", exempt: "tc-e", reverseCharge: "tc-rc", names: {}, detectedAt: "2026-10-01T00:00:00Z" };

const profile = (patch: Partial<SupplierProfile> = {}): SupplierProfile => ({
  vendorId: "v-acme", vendorName: "Acme Appliances Ltd", aliases: ["Acme", "Acme Home"], emailDomains: ["acme.example"], contacts: [], terms: null, statementAccount: true,
  blockAfterDaysOverdue: 13, safeDaysOverdue: null, pressure: "high", onHold: false, proformaOnly: false, paymentMethods: ["bacs"], paymentLinkWording: null, allocateOldestFirst: true,
  defaultAccountName: null, categoryHints: {}, classHints: {}, autoPost: false, creditLimit: null, notes: "", updatedBy: "test", updatedAt: "2026-10-01T00:00:00Z", ...patch,
});

const line = (id: string, description: string, net: string, vat: string, extra: Partial<ExtractedInvoice["lines"][number]> = {}): ExtractedInvoice["lines"][number] => ({
  id, description, sku: null, itemFamily: "unknown", useContext: "unknown", net, vat, gross: String(Math.round((parseFloat(net) + parseFloat(vat)) * 100) / 100), vatEvidenceQuote: `VAT ${vat}`, ...extra,
});

const invoice = (patch: Partial<ExtractedInvoice> = {}): ExtractedInvoice => ({
  documentType: "invoice", documentCount: 1, supplierIdentity: "Acme Appliances Ltd", documentNumber: "INV-1001", currency: "GBP",
  invoiceDateText: "29/09/2026", confirmedIsoDate: "2026-09-29", dateEvidenceQuote: "29/09/2026", projectReference: null, poReference: "PO-2026-AB12C",
  net: "1000.00", vat: "200.00", gross: "1200.00",
  lines: [line("1", "Series 6 built-in oven HBG5785S6B", "800.00", "160.00"), line("2", "Delivery charge", "200.00", "40.00")],
  ...patch,
});

const ctx = (patch: Partial<ResolveContext> = {}): ResolveContext => ({
  ref, taxCodes, profile: null, senderDomain: null, senderEmail: null,
  orders: [{ reference: "PO-2026-AB12C", projectId: "L1", projectName: "John Smith", orderType: "contract" }],
  projects: [{ id: "L1", name: "John Smith", lastName: "Smith" }, { id: "L2", name: "Anita Patel", lastName: "Patel" }, { id: "L3", name: "Raj Patel", lastName: "Patel" }],
  vendorHistory: [], receivedAt: "2026-10-01T09:00:00Z", ...patch,
});

// ------------------------------------------------------------------ vendor
test("vendor: exact display name scores 1.0, normalised 0.8, unknown proposes a vendor", () => {
  assert.equal(scoreVendor("Acme Appliances Ltd", ctx()).score, 1);
  assert.equal(scoreVendor("acme appliances", ctx()).vendor?.id, "v-acme");
  assert.ok(scoreVendor("acme appliances", ctx()).score >= 0.8);
  const unknown = resolveInvoice(invoice({ supplierIdentity: "Widget Works Ltd" }), ctx({ senderEmail: "ap@widgets.example" }));
  assert.ok(unknown.reasons.includes("VENDOR_UNKNOWN"));
  assert.equal(unknown.resolution.vendorId, null);
  assert.deepEqual(unknown.resolution.vendorProposed, { displayName: "Widget Works Ltd", email: "ap@widgets.example" });
  assert.equal(unknown.confidence, 0);
});

test("vendor: supplier profile found by sender domain wins over the name on the PDF", () => {
  const r = scoreVendor("A/C/M/E Hausgeräte GmbH", ctx({ profile: profile(), senderDomain: "acme.example" }));
  assert.equal(r.vendor?.id, "v-acme"); assert.equal(r.score, 1); assert.equal(r.source, "profile");
});

test("vendor: sender domain on the QuickBooks vendor record scores 0.9; ambiguous normalised names stay below 0.8; our own domain never identifies a vendor", () => {
  const dom = scoreVendor("Stone Group Fabrication", ctx({ senderDomain: "stonegroup.example" }));
  assert.equal(dom.vendor?.id, "v-stone"); assert.equal(dom.score, 0.9);
  const amb = scoreVendor("Bluewater Ltd", ctx());
  assert.ok(amb.score < 0.8, `Bluewater / Bluewater UK collide → ${amb.score}`);
  assert.ok(resolveInvoice(invoice({ supplierIdentity: "Bluewater Ltd" }), ctx()).reasons.includes("VENDOR_UNKNOWN"));
  const internalRef: QboRefData = { ...ref, vendors: [{ id: "v-us", name: "Our Own Co", email: "x@example.com", termId: null, active: true }] };
  assert.notEqual(scoreVendor("Something", ctx({ ref: internalRef, senderDomain: "example.com", internalDomains: ["example.com"] })).source, "domain");
  assert.equal(scoreVendor("Something", ctx({ ref: internalRef, senderDomain: "example.com" })).source, "domain");
});

test("vendor: override id is authoritative", () => {
  const r = resolveInvoice(invoice({ supplierIdentity: "nonsense" }), ctx({ overrides: { vendorId: "v-blue" } }));
  assert.equal(r.resolution.vendorId, "v-blue"); assert.equal(r.resolution.vendorScore, 1); assert.equal(r.resolution.vendorSource, "override");
});

// ------------------------------------------------------------------- class
test("class: CRM PO reference on the invoice → the customer's class at 0.9; vendor history agreement → 1.0", () => {
  const a = resolveClass(invoice(), ctx());
  assert.equal(a.classId, "c-smith"); assert.equal(a.score, 0.9); assert.equal(a.projectId, "L1"); assert.equal(a.matchedPo?.reference, "PO-2026-AB12C");
  const b = resolveClass(invoice(), ctx({ vendorHistory: [{ classId: "c-smith", className: "John Smith", accountId: "a-app", accountName: "Appliances" }] }));
  assert.equal(b.score, 1);
});

test("class: project name in the delivery address matches the PO without a reference", () => {
  const x = invoice({ poReference: null, lines: [line("1", "Oven — deliver to Mr John Smith, 12 High St", "1000.00", "200.00")] });
  const r = resolveClass(x, ctx({ orders: [{ reference: "PO-X", projectId: "L1", projectName: "John Smith" }] }));
  assert.equal(r.classId, "c-smith"); assert.equal(r.score, 0.9);
});

test("class: surname-only match scores 0.8; two projects sharing a surname → unresolved with candidates", () => {
  const one = resolveClass(invoice({ poReference: null, lines: [line("1", "Worktop for Smith kitchen", "1000.00", "200.00")] }), ctx({ orders: [] }));
  assert.equal(one.classId, "c-smith"); assert.equal(one.score, 0.8);
  const two = resolveClass(invoice({ poReference: null, lines: [line("1", "Worktop for Patel kitchen", "1000.00", "200.00")] }), ctx({ orders: [] }));
  assert.equal(two.classId, null); assert.equal(two.score, 0);
  assert.deepEqual(two.candidates.map((c) => c.classId).sort(), ["c-patel", "c-patel2"]);
});

test("class: history alone — one consistent class 0.7, several → 0 with candidates; no evidence → CLASS_UNRESOLVED", () => {
  const x = invoice({ poReference: null, lines: [line("1", "Hob", "1000.00", "200.00")] });
  const single = resolveClass(x, ctx({ orders: [], vendorHistory: [{ classId: "c-okonkwo", className: "Okonkwo", accountId: null, accountName: null }, { classId: "c-okonkwo", className: "Okonkwo", accountId: null, accountName: null }] }));
  assert.equal(single.classId, "c-okonkwo"); assert.equal(single.score, 0.7);
  const multi = resolveClass(x, ctx({ orders: [], vendorHistory: [{ classId: "c-okonkwo", className: "Okonkwo", accountId: null, accountName: null }, { classId: "c-smith", className: "John Smith", accountId: null, accountName: null }] }));
  assert.equal(multi.score, 0); assert.equal(multi.candidates.length, 2);
  const none = resolveInvoice(x, ctx({ orders: [] }));
  assert.ok(none.reasons.includes("CLASS_UNRESOLVED"));
  assert.ok(none.confidence < 0.9);
});

test("class: allowNoClass posts an overhead bill without a class and without the reason", () => {
  const r = resolveInvoice(invoice({ poReference: null, lines: [line("1", "Hob", "1000.00", "200.00")] }), ctx({ orders: [], overrides: { allowNoClass: true } }));
  assert.ok(!r.reasons.includes("CLASS_UNRESOLVED")); assert.equal(r.resolution.classScore, 1);
});

// ----------------------------------------------------------------- account
test("item-family table maps every family and defaults to Products and Units", () => {
  const cases: [string, string][] = [
    ["Built-in oven", "Appliances"], ["Induction hob", "Appliances"], ["Integrated fridge freezer", "Appliances"], ["Extractor hood", "Appliances"],
    ["Quartz worktop 30mm", "Worktops"], ["Granite upstands", "Worktops"], ["Laminate top 3m", "Worktops"], ["Oak upstands", DEFAULT_ACCOUNT],
    ["Undermount sink", "Sink and Taps"], ["Boiling water tap", "Sink and Taps"],
    ["Porcelain floor tiles 600x600", "Tiles"],
    ["Delivery charge", "Delivery and Removals"], ["Carriage", "Delivery and Removals"], ["Removal of old kitchen", "Delivery and Removals"],
    ["Installation labour", "Installation"], ["Fitting kit", "Installation"],
    ["Remedial visit — damaged door", "Remedials"], ["Replacement hinge plate", "Remedials"],
    ["Additional wall unit", "Additionals"], ["Extra plinth", "Additionals"],
    ["Soft-close hinges", "Purchase Accessories"], ["Drawer runners", "Purchase Accessories"], ["Bar handles brushed brass", "Purchase Accessories"],
    ["Base unit 600 2 door", DEFAULT_ACCOUNT], ["Tall larder", DEFAULT_ACCOUNT],
  ];
  for (const [text, want] of cases) assert.equal(itemFamilyAccount(text).account, want, text);
  assert.ok(ITEM_FAMILY_TABLE.length >= 9);
});

test("account precedence: profile hint → PO order type → specific family → profile default → table default", () => {
  const p = profile({ defaultAccountName: "Appliances", categoryHints: { "care kit": "Purchase Accessories" } });
  assert.deepEqual(accountNameFor({ description: "Oven care kit" }, { profile: p }), { name: "Purchase Accessories", source: "hint" });
  assert.deepEqual(accountNameFor({ description: "Oven door glass" }, { profile: p, orderType: "remedial" }), { name: "Remedials", source: "order_type" });
  assert.deepEqual(accountNameFor({ description: "Extra oven" }, { profile: p, orderType: "addon" }), { name: "Additionals", source: "order_type" });
  assert.deepEqual(accountNameFor({ description: "Delivery charge" }, { profile: p }), { name: "Delivery and Removals", source: "family" });
  assert.deepEqual(accountNameFor({ description: "HBG5785S6B" }, { profile: p }), { name: "Appliances", source: "profile" });
  assert.deepEqual(accountNameFor({ description: "HBG5785S6B" }, { profile: null }), { name: DEFAULT_ACCOUNT, source: "default" });
});

test("account ids come from QuickBooks; a name missing from the chart raises ACCOUNT_UNRESOLVED", () => {
  const ok = resolveInvoice(invoice(), ctx());
  assert.deepEqual(ok.resolution.lines.map((l) => l.accountId), ["a-app", "a-del"]);
  // A specific family (delivery) still beats the supplier default; a model-number-only line falls to the default, which is not in the chart.
  const bad = resolveInvoice(invoice({ lines: [line("1", "HBG5785S6B", "800.00", "160.00"), line("2", "Delivery charge", "200.00", "40.00")] }), ctx({ profile: profile({ defaultAccountName: "Kitchen Furniture" }) }));
  assert.ok(bad.reasons.includes("ACCOUNT_UNRESOLVED"));
  assert.equal(bad.resolution.lines[0].accountId, null); assert.equal(bad.resolution.lines[0].accountName, "Kitchen Furniture");
  assert.equal(bad.resolution.lines[1].accountId, "a-del");
});

// --------------------------------------------------------------------- VAT
test("VAT: 20% → standard, 0 → zero, reverse charge wording → RC, 5% → unresolved", () => {
  const x = invoice({
    net: "1300.00", vat: "250.00", gross: "1550.00",
    lines: [line("1", "Oven", "1000.00", "200.00"), line("2", "Printed manual", "100.00", "0.00"), line("3", "Reverse charge services", "100.00", "0.00", { vatEvidenceQuote: "Reverse charge: customer to account for VAT" }), line("4", "Child seat (reduced rate)", "100.00", "5.00")],
  });
  const r = resolveInvoice(x, ctx());
  assert.deepEqual(r.resolution.lines.map((l) => l.taxCodeId), ["tc-s", "tc-z", "tc-rc", null]);
  assert.deepEqual(r.resolution.lines.map((l) => l.vatKind), ["standard", "zero", "reverseCharge", null]);
  assert.ok(r.reasons.includes("VAT_CODE_UNRESOLVED"));
  assert.ok(!resolveInvoice(invoice(), ctx()).reasons.includes("VAT_CODE_UNRESOLVED"));
});

test("VAT: a realm without a detected code holds the bill; a per-line override fixes it", () => {
  const r = resolveInvoice(invoice(), ctx({ taxCodes: { ...taxCodes, standard: null } }));
  assert.ok(r.reasons.includes("VAT_CODE_UNRESOLVED"));
  const fixed = resolveInvoice(invoice(), ctx({ taxCodes: { ...taxCodes, standard: null }, overrides: { lines: [{ taxCodeId: "tc-s" }, { taxCodeId: "tc-s" }] } }));
  assert.ok(!fixed.reasons.includes("VAT_CODE_UNRESOLVED"));
});

// ------------------------------------------------------------------ totals
test("totals: lines must sum to net and net + VAT to gross within 2p", () => {
  assert.ok(!resolveInvoice(invoice(), ctx()).reasons.includes("TOTALS_MISMATCH"));
  assert.ok(!resolveInvoice(invoice({ gross: "1200.01" }), ctx()).reasons.includes("TOTALS_MISMATCH"));
  assert.ok(resolveInvoice(invoice({ gross: "1250.00" }), ctx()).reasons.includes("TOTALS_MISMATCH"));
  const short = resolveInvoice(invoice({ lines: [line("1", "Oven", "800.00", "160.00")] }), ctx());
  assert.ok(short.reasons.includes("TOTALS_MISMATCH")); assert.equal(short.resolution.totals.linesNet, 800);
  const noLines = resolveInvoice(invoice({ lines: [] }), ctx());
  assert.equal(noLines.resolution.lines.length, 1); assert.equal(noLines.resolution.lines[0].amount, 1000); assert.ok(!noLines.reasons.includes("TOTALS_MISMATCH"));
});

// ------------------------------------------------------------------- dates
test("UK dates: dd/mm/yyyy parses day-first; words and ISO are accepted", () => {
  assert.equal(parseUkDate("03/09/2026")?.iso, "2026-09-03");
  assert.equal(parseUkDate("03/09/2026")?.swapped, "2026-03-09");
  assert.equal(parseUkDate("29.09.26")?.iso, "2026-09-29");
  assert.equal(parseUkDate("Invoice date: 3rd September 2026")?.iso, "2026-09-03");
  assert.equal(parseUkDate("2026-09-03")?.iso, "2026-09-03");
  assert.equal(parseUkDate("September 2026"), null);
});

test("date sanity: day ≤ 12 and > 45 days before the email, or a future date, is DATE_AMBIGUOUS", () => {
  assert.equal(dateSanity("2026-09-29", false, "2026-10-01T09:00:00Z").ok, true);
  assert.equal(dateSanity("2026-03-09", true, "2026-10-01T09:00:00Z").ok, false);   // 09/03 read as 9 March — probably 3 September
  assert.equal(dateSanity("2026-09-03", true, "2026-10-01T09:00:00Z").ok, true);
  assert.equal(dateSanity("2026-11-03", true, "2026-10-01T09:00:00Z").ok, false);   // future
  const r = resolveInvoice(invoice({ confirmedIsoDate: null, invoiceDateText: "09/03/2026" }), ctx());
  assert.ok(r.reasons.includes("DATE_AMBIGUOUS")); assert.equal(r.resolution.txnDate, "2026-03-09"); assert.ok(r.confidence < 0.9);
  const ok = resolveInvoice(invoice({ confirmedIsoDate: null, invoiceDateText: "29/09/2026" }), ctx());
  assert.ok(!ok.reasons.includes("DATE_AMBIGUOUS")); assert.equal(ok.resolution.txnDate, "2026-09-29");
});

// ------------------------------------------------------------------- terms
test("due date: vendor TermRef (end of following month / Net N), then profile terms, else TERMS_MISSING", () => {
  const eom = resolveInvoice(invoice(), ctx());
  assert.equal(eom.resolution.dueDate, "2026-10-31"); assert.equal(eom.resolution.termName, "End of following month");
  const net30 = resolveInvoice(invoice({ supplierIdentity: "Bluewater UK" }), ctx());
  assert.equal(net30.resolution.dueDate, "2026-10-29");
  const none = resolveInvoice(invoice({ supplierIdentity: "The Stone Group" }), ctx());
  assert.ok(none.reasons.includes("TERMS_MISSING")); assert.equal(none.resolution.dueDate, null); assert.ok(none.confidence <= 0.8);
  const viaProfile = resolveInvoice(invoice({ supplierIdentity: "The Stone Group" }), ctx({ profile: profile({ vendorId: "v-stone", vendorName: "The Stone Group", terms: { kind: "days", days: 45 } }) }));
  assert.equal(viaProfile.resolution.dueDate, "2026-11-13"); assert.ok(!viaProfile.reasons.includes("TERMS_MISSING"));
  assert.equal(termSpecFor(ref, null, profile({ terms: null, statementAccount: true }))?.spec.kind, "eom_next");
});

// --------------------------------------------------------------- decision
test("fully resolved invoice reaches confidence ≥ 0.9 with no reasons; any gap drops it below", () => {
  const good = resolveInvoice(invoice(), ctx({ vendorHistory: [{ classId: "c-smith", className: "John Smith", accountId: "a-app", accountName: "Appliances" }] }));
  assert.deepEqual(good.reasons, []); assert.equal(good.confidence, 1);
  const po = resolveInvoice(invoice(), ctx());
  assert.equal(po.confidence, 0.9);
  assert.ok(resolveInvoice(invoice({ documentNumber: "" }), ctx()).reasons.includes("DOC_NUMBER_MISSING"));
  assert.ok(resolveInvoice(invoice({ documentCount: 2 }), ctx()).reasons.includes("MULTIPLE_DOCUMENTS"));
  assert.ok(resolveInvoice(invoice({ currency: "EUR" }), ctx()).reasons.includes("CURRENCY_NOT_GBP"));
});

test("PO order type drives remedial / additional coding on every line", () => {
  const r = resolveInvoice(invoice({ lines: [line("1", "Oven door", "1000.00", "200.00")] }), ctx({ orders: [{ reference: "PO-2026-AB12C", projectId: "L1", projectName: "John Smith", orderType: "remedial" }] }));
  assert.equal(r.resolution.lines[0].accountName, "Remedials"); assert.equal(r.resolution.matchedPo?.orderType, "remedial");
});

// -------------------------------------------------- trading names / aliases
const tradingRef: QboRefData = {
  ...ref,
  vendors: [
    ...ref.vendors,
    { id: "v-doorcraft", name: "Doorcraft", email: null, termId: null, active: true },
    { id: "v-hobtec", name: "HOBTEC", email: null, termId: null, active: true },
    { id: "v-spray", name: "Sprayworks Finish", email: null, termId: null, active: true },
    { id: "v-board", name: "Boardline Ltd", email: null, termId: null, active: true },
  ],
};

test("vendor: trading names, address segments and vendor-name-in-identity resolve at ≥ 0.8", () => {
  const c = ctx({ ref: tradingRef });
  // A " T/A " segment that is the vendor's exact display name is as certain as the whole name being exact.
  const ta = scoreVendor("Oakwood Door Designs Ltd T/A Doorcraft", c);
  assert.equal(ta.vendor?.id, "v-doorcraft"); assert.equal(ta.score, 1); assert.equal(ta.source, "name");
  // Address segments never equal the vendor name; "HOBTEC" is found as a whole word inside the identity → 0.8.
  const hob = scoreVendor("HOBTEC Holding GmbH, Innstrasse 1, 6342 Niederndorf, AUSTRIA", c);
  assert.equal(hob.vendor?.id, "v-hobtec"); assert.equal(hob.score, 0.8);
  const spray = scoreVendor("Sprayworks Finish T/A RBC London LLP", c);
  assert.equal(spray.vendor?.id, "v-spray"); assert.ok(spray.score >= 0.8);
  const lower = scoreVendor("Oakwood Door Designs Ltd t/a Doorcraft", c);
  assert.equal(lower.vendor?.id, "v-doorcraft");
  const words = scoreVendor("Oakwood Door Designs Limited trading as Doorcraft", c);
  assert.equal(words.vendor?.id, "v-doorcraft"); assert.ok(words.score >= 0.8);
  // Normalised (not exact) segment: "Doorcraft Ltd" → 0.8.
  const norm = scoreVendor("Oakwood Door Designs Ltd T/A Doorcraft Ltd", c);
  assert.equal(norm.vendor?.id, "v-doorcraft"); assert.equal(norm.score, 0.8);
  // Whole invoice resolves without VENDOR_UNKNOWN.
  const r = resolveInvoice(invoice({ supplierIdentity: "Oakwood Door Designs Ltd T/A Doorcraft" }), c);
  assert.ok(!r.reasons.includes("VENDOR_UNKNOWN")); assert.equal(r.resolution.vendorId, "v-doorcraft"); assert.equal(r.resolution.vendorSource, "name");
});

test("vendor: containment needs whole words of ≥ 4 chars and a unique vendor; short or ambiguous hits stay below 0.8", () => {
  const c = ctx({ ref: tradingRef });
  // "hobtec" as a fragment inside another word is not a match.
  assert.ok(scoreVendor("Superhobtech Joinery Ltd", c).score < 0.8);
  // Bluewater / Bluewater UK collide → ambiguous even via containment.
  const amb = scoreVendor("Bluewater Professional, Unit 4, Oxford", c);
  assert.ok(amb.score < 0.8, `ambiguous → ${amb.score}`);
  // A vendor name shorter than 4 chars never matches by containment.
  const shortRef: QboRefData = { ...ref, vendors: [{ id: "v-abc", name: "ABC", email: null, termId: null, active: true }] };
  assert.equal(scoreVendor("Something ABC Holdings, London", ctx({ ref: shortRef })).score < 0.8, true);
});

test("vendor: an alias on any supplier profile resolves the vendor (source alias, ≤ 0.9) and beats a weaker name match", () => {
  const profiles = [{ vendorId: "v-board", vendorName: "Boardline Ltd", aliases: ["Board Line Technologies (Boardline) Limited", "BLT"] }];
  const c = ctx({ ref: tradingRef, profiles });
  const exact = scoreVendor("Board Line Technologies (Boardline) Limited", c);
  assert.equal(exact.vendor?.id, "v-board"); assert.equal(exact.source, "alias"); assert.equal(exact.score, 0.9);
  const seg = scoreVendor("Acme Boards Ltd T/A BLT, Unit 9", c);
  assert.equal(seg.vendor?.id, "v-board"); assert.equal(seg.source, "alias"); assert.ok(seg.score >= 0.8);
  // A profile pointing at a vendor that no longer exists in QuickBooks is ignored.
  const gone = scoreVendor("BLT", ctx({ ref: tradingRef, profiles: [{ vendorId: "v-missing", vendorName: "Gone", aliases: ["BLT"] }] }));
  assert.notEqual(gone.source, "alias");
  // Override and sender-domain still rank above an alias.
  assert.equal(scoreVendor("BLT", ctx({ ref: tradingRef, profiles, senderDomain: "acme.example" })).source, "domain");
  assert.equal(scoreVendor("BLT", ctx({ ref: tradingRef, profiles, overrides: { vendorId: "v-acme" } })).source, "override");
});

// ----------------------------------------------------------- own documents
test("own document: our company name as the supplier, or our VAT number in the identity, is not a supplier bill", () => {
  const own = { name: "Acme Worktops Ltd", vatNumber: "GB 123 456 789" };
  assert.equal(isOwnDocument({ supplierIdentity: "Acme Worktops Ltd" }, own), true);
  assert.equal(isOwnDocument({ supplierIdentity: "ACME   WORKTOPS, 123 High Street, London" }, own), true);
  assert.equal(isOwnDocument({ supplierIdentity: "Some Kitchens Ltd, VAT No. GB 123 456 789" }, own), true);
  assert.equal(isOwnDocument({ supplierIdentity: "Some Kitchens Ltd VAT GB123456789" }, own), true);
  assert.equal(isOwnDocument({ supplierIdentity: "Acme Hotels and Resorts" }, own), false);
  assert.equal(isOwnDocument({ supplierIdentity: "Acme Appliances Ltd, VAT GB 126 179 696" }, own), false);
  assert.equal(isOwnDocument({ supplierIdentity: "Other Ltd, order 1234567890" }, own), false, "VAT digits embedded in a longer number do not count");
  assert.equal(isOwnDocument({ supplierIdentity: "" }, own), false);
  assert.equal(isOwnDocument({ supplierIdentity: "Anyone" }, { name: "", vatNumber: null }), false, "no company identity configured → never flagged");
});

test("reason text: MULTIPLE_DOCUMENTS tells the reviewer how many documents and what to do", () => {
  assert.equal(reasonText("MULTIPLE_DOCUMENTS", { documentCount: 3 }), "MULTIPLE_DOCUMENTS: PDF contains 3 documents — split and re-send");
  assert.equal(reasonText("VENDOR_UNKNOWN", { documentCount: 1 }), "VENDOR_UNKNOWN");
  const r = resolveInvoice(invoice({ documentCount: 2 }), ctx());
  assert.ok(r.reasons.includes("MULTIPLE_DOCUMENTS")); assert.equal(r.confidence, 0);
});

// ----------------------------------------------------------- learned hints
const hint = (classId: string, className: string, projectId: string | null = null) => ({ classId, className, projectId, hits: 1, lastSeen: "2026-10-01T00:00:00Z" });

test("learned: a vendor class hint (surname) on the invoice resolves the class at 0.95 with source learned", () => {
  const x = invoice({ poReference: null, lines: [line("1", "Worktop, deliver to Okonkwo residence", "1000.00", "200.00")] });
  const p = profile({ classHints: { okonkwo: hint("c-okonkwo", "Okonkwo", "L9") } });
  const r = resolveClass(x, ctx({ orders: [], projects: [], profile: p, projectStatus: { L9: { id: "L9", status: "active" } } }));
  assert.equal(r.classId, "c-okonkwo"); assert.equal(r.score, 0.95);
  assert.equal(r.candidates[0].source, "learned"); assert.equal(r.candidates[0].token, "okonkwo"); assert.equal(r.projectId, "L9");
  // Whole invoice: no CLASS_UNRESOLVED, confidence ≥ 0.9 → postable by the autopilot.
  const full = resolveInvoice(x, ctx({ orders: [], projects: [], profile: p }));
  assert.ok(!full.reasons.includes("CLASS_UNRESOLVED")); assert.ok(full.confidence >= 0.9);
});

test("learned: global CLASS_HINT# tokens (postcode, PO ref) apply to any vendor; compact postcodes still match", () => {
  const global = [{ token: "tw2 7ld", classId: "c-patel", className: "Anita Patel", projectId: "L2", hits: 2, lastSeen: "2026-10-01T00:00:00Z" }];
  const a = resolveClass(invoice({ poReference: null, lines: [line("1", "Sink — site: 12 Elm Road, Twickenham TW2 7LD", "1000.00", "200.00")] }), ctx({ orders: [], projects: [], globalClassHints: global }));
  assert.equal(a.classId, "c-patel"); assert.equal(a.score, 0.95);
  const b = resolveClass(invoice({ poReference: null, lines: [line("1", "Sink — site TW27LD", "1000.00", "200.00")] }), ctx({ orders: [], projects: [], globalClassHints: global }));
  assert.equal(b.classId, "c-patel");
  assert.equal(tokenAppears("tw2 7ld", invoice({ lines: [line("1", "nothing here", "1.00", "0.20")] })), false);
  const po = resolveClass(invoice({ poReference: "PO-2026-ZZ9", lines: [line("1", "Hob", "1000.00", "200.00")] }), ctx({ orders: [], projects: [], globalClassHints: [{ token: "po 2026 zz9", classId: "c-smith", className: "John Smith", projectId: "L1", hits: 1, lastSeen: "2026-10-01T00:00:00Z" }] }));
  assert.equal(po.classId, "c-smith"); assert.equal(po.score, 0.95);
});

test("learned: hints for closed projects (completed / cancelled / lost > 60 days) are ignored; recent completions still apply", () => {
  const now = "2026-10-06T09:00:00Z";
  assert.equal(projectOpen(undefined, now), true);
  assert.equal(projectOpen({ id: "L", status: "active" }, now), true);
  assert.equal(projectOpen({ id: "L", completedAt: "2026-09-20" }, now), true, "completed 16 days ago → still open for hints");
  assert.equal(projectOpen({ id: "L", completedAt: "2026-07-01" }, now), false);
  assert.equal(projectOpen({ id: "L", status: "cancelled", closedAt: "2026-07-01" }, now), false);
  assert.equal(projectOpen({ id: "L", status: "cancelled" }, now), false, "cancelled with no date → closed");
  assert.equal(projectOpen({ id: "L", status: "lost", closedAt: "2026-10-01" }, now), true);
  const x = invoice({ poReference: null, lines: [line("1", "Worktop for Okonkwo", "1000.00", "200.00")] });
  const p = profile({ classHints: { okonkwo: hint("c-okonkwo", "Okonkwo", "L9") } });
  const closed = resolveClass(x, ctx({ orders: [], projects: [], profile: p, now, projectStatus: { L9: { id: "L9", completedAt: "2026-06-01" } } }));
  assert.equal(closed.classId, null); assert.equal(closed.candidates.length, 0);
  const open = resolveClass(x, ctx({ orders: [], projects: [], profile: p, now, projectStatus: { L9: { id: "L9", completedAt: "2026-09-30" } } }));
  assert.equal(open.classId, "c-okonkwo");
});

test("learned: two hints pointing at different classes, or a hint disagreeing with the PO, hold with candidates; agreement with history lifts to 1.0; a class gone from QuickBooks is skipped", () => {
  const x = invoice({ poReference: null, lines: [line("1", "Worktop Okonkwo / Patel TW2 7LD", "1000.00", "200.00")] });
  const p = profile({ classHints: { okonkwo: hint("c-okonkwo", "Okonkwo") } });
  const two = resolveClass(x, ctx({ orders: [], projects: [], profile: p, globalClassHints: [{ token: "tw2 7ld", classId: "c-patel", className: "Anita Patel", projectId: null, hits: 1, lastSeen: "" }] }));
  assert.equal(two.classId, null); assert.equal(two.score, 0); assert.deepEqual(two.candidates.map((c) => c.classId).sort(), ["c-okonkwo", "c-patel"]);
  const conflict = resolveClass(invoice(), ctx({ profile: profile({ classHints: { "po 2026 ab12c": hint("c-okonkwo", "Okonkwo") } }) }));
  assert.equal(conflict.classId, null, "learned Okonkwo vs PO → John Smith is ambiguous");
  const agree = resolveClass(invoice({ poReference: null, lines: [line("1", "Okonkwo worktop", "1000.00", "200.00")] }), ctx({ orders: [], projects: [], profile: p, vendorHistory: [{ classId: "c-okonkwo", className: "Okonkwo", accountId: null, accountName: null }] }));
  assert.equal(agree.score, 1);
  const gone = matchLearnedClass(invoice({ lines: [line("1", "Okonkwo", "1.00", "0.20")] }), { ref, profile: profile({ classHints: { okonkwo: hint("c-deleted", "Old") } }) });
  assert.equal(gone.length, 0);
  // An explicit override still wins over everything learned.
  assert.equal(resolveClass(x, ctx({ profile: p, overrides: { classId: "c-smith" } })).classId, "c-smith");
});

// =============================================================== learning
const cfg = (patch: Partial<AutopilotConfig> = {}): AutopilotConfig => ({ ...DEFAULT_AUTOPILOT, ...patch });
const item = (patch: Partial<AutopilotItem> = {}): AutopilotItem => ({ state: "proposed", confidence: 0.95, reasons: [], vendorId: "v-acme", vendorScore: 1, classId: "c-smith", profile: { autoPost: false, onHold: false }, ...patch });

test("autopilot: manual never posts; posting off never posts in any mode", () => {
  assert.equal(autopilotDecision(cfg(), item(), true).post, false);
  assert.equal(autopilotDecision(cfg({ mode: "full" }), item(), false).post, false);
  assert.match(autopilotDecision(cfg({ mode: "full" }), item(), false).reason, /posting is off/);
  assert.match(autopilotDecision(cfg(), item(), true).reason, /manual/);
});

test("autopilot: assisted posts only suppliers on auto-post; full posts every certain, classed, known-vendor item", () => {
  const assisted = cfg({ mode: "assisted" });
  assert.equal(autopilotDecision(assisted, item(), true).post, false);
  assert.equal(autopilotDecision(assisted, item({ profile: { autoPost: true, onHold: false } }), true).post, true);
  assert.equal(autopilotDecision(assisted, item({ profile: { autoPost: true, onHold: true } }), true).post, false, "on hold blocks");
  assert.equal(autopilotDecision(assisted, item({ profile: null }), true).post, false, "no profile = not on auto-post");
  const full = cfg({ mode: "full" });
  assert.equal(autopilotDecision(full, item(), true).post, true);
  assert.equal(autopilotDecision(full, item({ profile: null }), true).post, true);
  assert.equal(autopilotDecision(full, item({ state: "held" }), true).post, false);
});

test("autopilot: confidence, class and vendor gates", () => {
  const full = cfg({ mode: "full" });
  assert.equal(autopilotDecision(full, item({ confidence: 0.85 }), true).post, false);
  assert.equal(autopilotDecision(cfg({ mode: "full", minConfidence: 0.8 }), item({ confidence: 0.85 }), true).post, true);
  assert.equal(autopilotDecision(full, item({ classId: null, confidence: 0, reasons: ["CLASS_UNRESOLVED"] }), true).post, false, "requireClass default on");
  assert.match(autopilotDecision(full, item({ classId: null, confidence: 0, reasons: ["CLASS_UNRESOLVED"] }), true).reason, /requireClass/);
  // requireClass off: an otherwise clean overhead bill posts with allowNoClass, judged on the vendor match.
  const noClass = autopilotDecision(cfg({ mode: "full", requireClass: false }), item({ classId: null, confidence: 0, vendorScore: 1, reasons: ["CLASS_UNRESOLVED"] }), true);
  assert.equal(noClass.post, true); assert.deepEqual(noClass.overrides, { allowNoClass: true });
  assert.equal(autopilotDecision(cfg({ mode: "full", requireClass: false }), item({ classId: null, confidence: 0, reasons: ["CLASS_UNRESOLVED", "VAT_CODE_UNRESOLVED"] }), true).post, false, "other reasons still block");
  assert.equal(autopilotDecision(full, item({ vendorId: null, profile: null }), true).post, false);
  assert.equal(autopilotDecision(cfg({ mode: "full", requireKnownVendor: false }), item({ vendorId: null, profile: null }), true).post, false, "new supplier still needs the owner's APPROVE");
  assert.equal(autopilotDecision(cfg({ mode: "full", requireKnownVendor: false }), item({ vendorId: null, profile: null, ownerApproved: true }), true).post, true);
  assert.equal(autopilotDecision(full, item({ reasons: ["TOTALS_MISMATCH"] }), true).post, false, "a blocking reason with confidence still high is refused");
  assert.equal(autopilotDecision(full, item({ reasons: ["TERMS_MISSING"], confidence: 0.9 }), true).post, true, "TERMS_MISSING alone is not blocking (due date defaults)");
});

test("autopilot: patch validation", () => {
  assert.deepEqual(normaliseAutopilotPatch({ mode: "assisted", minConfidence: 0.925, requireClass: false }), { mode: "assisted", minConfidence: 0.93, requireClass: false });
  assert.throws(() => normaliseAutopilotPatch({ mode: "turbo" as never }));
  assert.throws(() => normaliseAutopilotPatch({ minConfidence: 0.2 }));
  assert.deepEqual(normaliseAutopilotPatch({}), {});
});

const pline = (description: string): ExtractedInvoice["lines"][number] => ({ id: "1", description, sku: null, itemFamily: "unknown", useContext: "unknown", net: "100.00", vat: "20.00", gross: "120.00", vatEvidenceQuote: null });
const pinvoice = (patch: Partial<ExtractedInvoice> = {}): ExtractedInvoice => ({
  documentType: "invoice", documentCount: 1, supplierIdentity: "Acme Appliances Ltd", documentNumber: "INV-77", currency: "GBP", invoiceDateText: "01/10/2026", confirmedIsoDate: "2026-10-01", dateEvidenceQuote: null,
  projectReference: null, poReference: null, net: "100.00", vat: "20.00", gross: "120.00", lines: [pline("Oven")], ...patch,
});
const projects = [{ id: "L1", name: "John Smith", lastName: "Smith", postcode: "TW2 7LD" }, { id: "L2", name: "Anita Patel", lastName: "Patel", postcode: "SL1 4NL" }, { id: "L3", name: "Raj Patel", lastName: "Patel", postcode: null }, { id: "L4", name: "Li Wu", lastName: "Wu", postcode: "W1 1AA" }];
const orders = [{ reference: "PO-2026-AB12C", projectId: "L1", projectName: "John Smith" }, { reference: "PO-2026-QQ77X", projectId: "L2", projectName: "Anita Patel" }];

test("class tokens: surname (global ≥ 4 chars), postcode and CRM PO ref for the project; nothing from the supplier name or doc number", () => {
  const x = pinvoice({ poReference: "PO-2026-AB12C", lines: [pline("Oven — deliver to Mr Smith, 12 Elm Rd, TW2 7LD")] });
  const t = deriveClassTokens(x, { classId: "c-smith", className: "John Smith", projectId: "L1" }, { projects, orders });
  assert.deepEqual(t.map((k) => [k.token, k.kind, k.scope, k.projectId]), [["smith", "surname", "global", "L1"], ["tw2 7ld", "postcode", "global", "L1"], ["po 2026 ab12c", "po", "global", "L1"]]);
  // No project pointer on the invoice → nothing learned (never the supplier identity or INV number).
  assert.deepEqual(deriveClassTokens(pinvoice({ lines: [pline("Acme Appliances INV-77")] }), { classId: "c-smith", className: "John Smith", projectId: "L1" }, { projects, orders }), []);
  assert.deepEqual(deriveClassTokens(x, { classId: null, className: null }, { projects, orders }), []);
});

test("class tokens: project found from the class name when the resolver had no projectId; ambiguous surnames resolve by full name; short surnames stay vendor-scoped", () => {
  assert.equal(projectForClass({ classId: "c", className: "Anita Patel" }, projects)?.id, "L2");
  assert.equal(projectForClass({ classId: "c", className: "Patel" }, projects), null, "two Patels");
  assert.equal(projectForClass({ classId: "c", className: "Nobody Here" }, projects), null);
  const t = deriveClassTokens(pinvoice({ lines: [pline("Worktop for Patel, SL1 4NL")] }), { classId: "c-patel", className: "Anita Patel" }, { projects, orders });
  assert.deepEqual(t.map((k) => k.token), ["patel", "sl1 4nl"]);
  assert.equal(t[0].projectId, "L2");
  const short = deriveClassTokens(pinvoice({ lines: [pline("Hob for Mr Wu W1 1AA")] }), { classId: "c-wu", className: "Li Wu", projectId: "L4" }, { projects, orders });
  assert.equal(short.find((k) => k.kind === "surname")?.token, undefined, "2-letter surname too weak");
  assert.equal(short.find((k) => k.kind === "postcode")?.scope, "global");
});

test("class tokens: a PO reference belonging to another project is not learned for this class", () => {
  const t = deriveClassTokens(pinvoice({ poReference: "PO-2026-QQ77X", lines: [pline("Oven for Smith")] }), { classId: "c-smith", className: "John Smith", projectId: "L1" }, { projects, orders });
  assert.deepEqual(t.map((k) => k.token), ["smith"]);
});

const res = (patch: Partial<Resolution> = {}): Resolution => ({
  vendorId: "v-acme", vendorName: "Acme", vendorScore: 1, vendorSource: "profile", docNumber: "INV-77", txnDate: "2026-10-01", dateNote: null,
  lines: [{ description: "Oven", amount: 100, vat: 20, accountId: "a-app", accountName: "Appliances", classId: "c-smith", className: "John Smith", taxCodeId: "tc-s", vatKind: "standard", accountSource: "family" }],
  classId: "c-smith", className: "John Smith", classScore: 0.9, classCandidates: [], projectId: "L1", matchedPo: null, dueDate: "2026-10-31", termName: "Net 30", totals: { net: 100, vat: 20, gross: 120, linesNet: 100 }, currency: "GBP", ...patch,
});

test("shapes: diff flags exactly what a human changed; line class beats header class", () => {
  const proposed = codingShape(res());
  assert.deepEqual(proposed, { vendorId: "v-acme", classId: "c-smith", className: "John Smith", accounts: ["Appliances"], vatKinds: ["standard"] });
  assert.deepEqual(diffShapes(proposed, codingShape(res())), { vendor: false, class: false, account: false, vat: false });
  const final = codingShape(res({ lines: [{ ...res().lines[0], classId: "c-patel", className: "Anita Patel", accountName: "Worktops", accountId: "a-work" }] }));
  assert.equal(final.classId, "c-patel");
  assert.deepEqual(diffShapes(proposed, final), { vendor: false, class: true, account: true, vat: false });
  assert.deepEqual(diffShapes(codingShape(null), proposed), { vendor: true, class: true, account: true, vat: true });
});

const decision = (patch: Partial<CodingDecision> = {}): CodingDecision => ({
  sha256: "a".repeat(64), vendorId: "v-acme", vendorName: "Acme", docNumber: "1", action: "post", by: "owner", at: "2026-10-01T00:00:00Z", autopilot: false, dryRun: false, confidence: 0.95,
  proposed: codingShape(res()), final: codingShape(res()), changed: { vendor: false, class: false, account: false, vat: false }, evidence: { invoiceTextTokens: [], senderDomain: null, fileName: null }, note: null, ...patch,
});

test("promotion: three consecutive agreeing posts (latest first); a class or account change in the last three resets it; holds do not count", () => {
  const ok = [decision({ at: "2026-10-03T00:00:00Z" }), decision({ at: "2026-10-02T00:00:00Z" }), decision({ at: "2026-10-01T00:00:00Z" })];
  assert.equal(promotionDue(ok), true);
  assert.equal(promotionDue(ok.slice(0, 2)), false);
  assert.equal(promotionDue([decision({ at: "2026-10-04T00:00:00Z", changed: { vendor: false, class: true, account: false, vat: false } }), ...ok]), false);
  assert.equal(promotionDue([decision({ at: "2026-10-04T00:00:00Z", changed: { vendor: false, class: false, account: false, vat: true } }), ...ok]), true, "a VAT-only change does not block promotion");
  assert.equal(promotionDue([decision({ at: "2026-10-04T00:00:00Z", action: "hold" }), ...ok.slice(0, 2)]), false);
  // Older disagreement beyond the streak window is forgiven.
  assert.equal(promotionDue([...ok, decision({ at: "2026-09-01T00:00:00Z", changed: { vendor: false, class: true, account: false, vat: false } })]), true);
});

test("stats: agreement rates over post/edit decisions, counts by action, average confidence", () => {
  const s = aggregateDecisions([
    decision(), decision({ changed: { vendor: false, class: true, account: false, vat: false } }), decision({ action: "hold", confidence: 0.5 }), decision({ action: "post", autopilot: true, by: "autopilot" }), decision({ action: "edit_posted", changed: { vendor: false, class: false, account: true, vat: false } }), decision({ action: "promote" }),
  ]);
  assert.equal(s.decisions, 6); assert.equal(s.proposals, 5); assert.equal(s.posted, 3); assert.equal(s.autoPosted, 1); assert.equal(s.held, 1); assert.equal(s.edited, 1);
  assert.equal(s.classAgreement, 0.75); assert.equal(s.accountAgreement, 0.75); assert.equal(s.vatAgreement, 1);
  assert.equal(s.avgConfidence, 0.84);
  assert.equal(aggregateDecisions([]).classAgreement, null);
});

// ================================================================ daily log
const row = (over: Partial<IntakeLogRow> = {}): IntakeLogRow => ({
  sha256: "a".repeat(64), received: "2026-10-05T09:15:00Z", touchedAt: "2026-10-05T09:15:00Z", mailbox: "info@example.com", sender: "ap@supplier.example", fileName: "INV-1.pdf",
  vendor: "Bluewater UK", docNumber: "INV-1", invoiceDate: "2026-10-01", dueDate: "2026-10-31", net: 100, vat: 20, gross: 120, vatKind: "standard", category: "Sink and Taps", className: "John Smith",
  state: "posted", billId: "123", reasons: "", confidence: 1, decidedBy: "intake-job (auto)", ...over,
});

test("csvField quotes commas, quotes and line breaks and doubles embedded quotes", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField("Smith, John"), '"Smith, John"');
  assert.equal(csvField('12" sink'), '"12"" sink"');
  assert.equal(csvField("line1\nline2"), '"line1\nline2"');
  assert.equal(csvField("a\r\nb"), '"a\r\nb"');
  assert.equal(csvField(null), "");
  assert.equal(csvField(undefined), "");
});

test("csvField keeps numbers but neutralises formula-looking text", () => {
  assert.equal(csvField(-12.5), "-12.50");
  assert.equal(csvField(7), "7");
  assert.equal(csvField("-12.50"), "-12.50");
  assert.equal(csvField("=SUM(A1:A9)"), "'=SUM(A1:A9)");
  assert.equal(csvField("+44 20 0000 0000"), "'+44 20 0000 0000");
  assert.equal(csvField("@everyone"), "'@everyone");
  assert.equal(csvField("-not a number"), "'-not a number");
});

test("intakeLogCsv: BOM, CRLF, header, one line per row, escaped reasons", () => {
  const csv = intakeLogCsv([row({ reasons: 'VENDOR_UNKNOWN; HELD:supplier says "credit due", chase', vendor: "Stone, The Group" })]);
  assert.ok(csv.startsWith("﻿"), "starts with UTF-8 BOM");
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines.at(-1), "", "ends with CRLF");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], CSV_COLUMNS.join(","));
  assert.ok(lines[1].includes('"Stone, The Group"'));
  assert.ok(lines[1].includes('"VENDOR_UNKNOWN; HELD:supplier says ""credit due"", chase"'));
  assert.ok(lines[1].includes(",100.00,20.00,120.00,"), "money at 2dp");
  assert.ok(!lines[1].includes("\n"), "no raw newlines in a row");
  // Parse back: a naive RFC-4180 reader must recover the same column count.
  const cells = lines[1].match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.filter((c, i, arr) => !(i === arr.length - 1 && c === ""));
  assert.equal(cells.length, CSV_COLUMNS.length);
});

test("intakeLogCsv prints the received time in the company time zone (Europe/London by default)", () => {
  const csv = intakeLogCsv([row({ received: "2026-10-05T09:15:00Z" })], "Europe/London"); // BST → 10:15
  assert.ok(csv.includes("2026-10-05 10:15,"), csv);
  const winter = intakeLogCsv([row({ received: "2026-12-05T09:15:00Z" })], "Europe/London");
  assert.ok(winter.includes("2026-12-05 09:15,"), winter);
});

test("logWindow: a London day in BST starts at 23:00Z the day before; ranges are inclusive", () => {
  assert.equal(dayStart("2026-10-05", "Europe/London"), "2026-10-04T23:00:00.000Z");
  assert.equal(dayStart("2026-12-05", "Europe/London"), "2026-12-05T00:00:00.000Z");
  const w = logWindow({ date: "2026-10-05" }, "Europe/London");
  assert.equal(w.from, "2026-10-04T23:00:00.000Z"); assert.equal(w.to, "2026-10-05T23:00:00.000Z"); assert.equal(w.label, "2026-10-05"); assert.equal(w.date, "2026-10-05");
  const r = logWindow({ from: "2026-10-01", to: "2026-10-05" }, "Europe/London");
  assert.equal(r.label, "2026-10-01_2026-10-05"); assert.equal(r.date, null);
  assert.throws(() => logWindow({ date: "05/10/2026" }));
  assert.throws(() => logWindow({ from: "2026-10-05", to: "2026-10-01" }));
});

const rec = (over: Partial<IntakeRecord>): IntakeRecord => ({
  sha256: "b".repeat(64), state: "proposed", evidence: { id: "e", sha256: "b".repeat(64), contentType: "application/pdf", size: 1 },
  arrivals: [{ mailbox: "accounts@example.com", messageId: "m1", attachmentId: "a1", fileName: "x.pdf", receivedAt: "2026-10-05T08:00:00Z", from: "ap@acme.example", subject: "Invoice", conversationId: null }],
  extraction: null, extractionError: null, resolution: null, reasons: ["CLASS_UNRESOLVED"], confidence: 0.6,
  qbo: { billId: null, attachableId: null, postedAt: null, dryRun: null }, decidedBy: null, decidedAt: null, createdAt: "2026-10-05T08:00:05Z", updatedAt: "2026-10-05T08:00:05Z", ...over,
});

test("rowsFromRecords picks records touched in the window and totals by state/category", () => {
  const w = logWindow({ date: "2026-10-05" }, "Europe/London");
  const resolution: Resolution = {
    vendorId: "v1", vendorName: "Acme Appliances Ltd", vendorScore: 1, vendorSource: "profile", docNumber: "INV-9", txnDate: "2026-10-01", dateNote: null,
    lines: [
      { description: "Oven", amount: 500, vat: 100, accountId: "a", accountName: "Appliances", classId: "c", className: "John Smith", taxCodeId: "t", vatKind: "standard", accountSource: "family" },
      { description: "Delivery", amount: 40, vat: 8, accountId: "d", accountName: "Delivery and Removals", classId: "c", className: "John Smith", taxCodeId: "t", vatKind: "standard", accountSource: "family" },
    ],
    classId: "c", className: "John Smith", classScore: 1, classCandidates: [], projectId: null, matchedPo: null, dueDate: "2026-11-30", termName: "EOM", totals: { net: 540, vat: 108, gross: 648, linesNet: 540 }, currency: "GBP",
  };
  const records: IntakeRecord[] = [
    rec({ sha256: "1".repeat(64), state: "posted", resolution, qbo: { billId: "77", attachableId: null, postedAt: "2026-10-05T08:01:00Z", dryRun: null }, reasons: [] }),
    rec({ sha256: "2".repeat(64) }),                                                   // proposed, uncoded, in window
    rec({ sha256: "3".repeat(64), state: "duplicate", resolution, reasons: ["QBO_BILL_EXISTS:77"] }),
    rec({ sha256: "4".repeat(64), createdAt: "2026-10-03T08:00:05Z", updatedAt: "2026-10-03T08:00:05Z", arrivals: [{ mailbox: "info@example.com", messageId: "m4", attachmentId: "a4", fileName: "old.pdf", receivedAt: "2026-10-03T08:00:00Z", from: "x@y.example", subject: null, conversationId: null }] }), // outside
    rec({ sha256: "5".repeat(64), createdAt: "2026-10-01T08:00:05Z", updatedAt: "2026-10-01T08:00:05Z", decidedAt: "2026-10-05T12:00:00Z", decidedBy: "owner", state: "held",
      arrivals: [{ mailbox: "info@example.com", messageId: "m5", attachmentId: "a5", fileName: "old.pdf", receivedAt: "2026-10-01T08:00:00Z", from: "x@y.example", subject: null, conversationId: null }] }), // arrived 1 Oct, decided today → in
  ];
  const rows = rowsFromRecords(records, w);
  assert.deepEqual(rows.map((r) => r.sha256[0]), ["5", "1", "2", "3"]);
  const posted = rows.find((r) => r.sha256[0] === "1")!;
  assert.equal(posted.category, "Appliances + Delivery and Removals"); assert.equal(posted.vatKind, "standard"); assert.equal(posted.billId, "77"); assert.equal(posted.gross, 648);
  const t = totalsFor(records, rows);
  assert.equal(t.rows, 4); assert.equal(t.posted, 1); assert.equal(t.proposed, 1); assert.equal(t.held, 1); assert.equal(t.duplicate, 1); assert.equal(t.review, 2);
  assert.equal(t.net, 540); assert.equal(t.vat, 108); assert.equal(t.gross, 648);   // duplicate excluded from money totals
  assert.deepEqual(t.byCategory.map((c) => [c.category, c.count, c.net, c.vat]), [["Appliances", 1, 500, 100], ["Delivery and Removals", 1, 40, 8], ["Uncoded", 2, 0, 0]]);
  assert.deepEqual(t.byState.find((s) => s.state === "duplicate"), { state: "duplicate", count: 1, gross: 648 });
});

// ============================================================== extractor
test("null VAT is coerced to 0.00 only when net equals gross (line and document level)", () => {
  const o = coerceAmountNulls({ net: "100.00", vat: null, gross: "100.00", lines: [
    { id: "1", net: "60.00", vat: null, gross: "60.00" },
    { id: "2", net: "40.00", vat: null, gross: "48.00" },
    { id: "3", net: null, vat: "0.00", gross: "25.00" },
    { id: "4", net: "0.00", vat: "0.00", gross: null },
    { id: "5", net: null, vat: "10.00", gross: "10.00" },
  ] });
  assert.equal(o.vat, "0.00");
  const lines = o.lines as Record<string, unknown>[];
  assert.equal(lines[0].vat, "0.00");
  assert.equal(lines[1].vat, null, "inconsistent siblings are left for the validator");
  assert.equal(lines[2].net, null, "net null with gross ≠ vat is not zero");
  assert.equal(lines[3].gross, "0.00");
  assert.equal(lines[4].net, "0.00", "gross === vat proves net is zero");
});

test("document-level VAT null stays null when net ≠ gross; non-amount fields untouched", () => {
  const o = coerceAmountNulls({ supplierIdentity: "X", net: "100.00", vat: null, gross: "120.00", dateEvidenceQuote: null, lines: [] });
  assert.equal(o.vat, null); assert.equal(o.dateEvidenceQuote, null); assert.equal(o.supplierIdentity, "X");
});
