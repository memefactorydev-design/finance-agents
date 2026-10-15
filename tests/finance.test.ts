// Finance core: invoices and receipts (with the confirmation rule), the
// four project P&Ls, ledger / class / supplier matching, report parsers,
// cashflow arithmetic, commission tiers and the report tabs. Runs against an
// in-memory store; nothing touches QuickBooks.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@/lib/core/store";
import { setStoreForTests } from "@/lib/core/server";
import { upsertProject } from "@/lib/crm/projects";
import { invoiceTotal, resolveSchedule } from "@/lib/crm/schedule";
import type { Invoice, SupplierOrder } from "@/lib/crm/types";
import { classByCustomerFuzzy, tokenNear } from "@/lib/qbo/client";
import { aggregateLedger, matchClasses, supplierAliasIndex, vendorMatches } from "@/lib/finance/ledger";
import { ackTotals, liveOrderCosts, pnlComparison } from "@/lib/finance/project-pnl";
import { deleteInvoice, editInvoice, InvoiceError, markInvoicePaid, nextInvoiceNumber, raiseScheduleInvoice, reconcileInvoices, recordPayment, setInvoiceStatus, setOrderFinance } from "@/lib/finance/invoices";
import { buildFinanceOverview, inWindow } from "@/lib/finance/overview";
import { parseVendorBalanceDetail } from "@/lib/finance/vendor-balances";
import { hasFinalInvoice, mergeRowOrder, monthsFromParsed, parseProfitAndLoss, projectCompletionDate, summariseColumn, type ClassPnl } from "@/lib/finance/qbo-pnl";
import { bucketFor, projectWeeks, type CashflowOutlook } from "@/lib/finance/cashflow";
import { addMonth, commissionLine, commissionMonths, getCommissionConfig, setCommissionConfig, tierPct } from "@/lib/finance/commission";
import { cashControlMatrix, cashflowMatrix, loansMatrix, pnlMonthMatrix, sliceA1, toCsv } from "@/lib/finance/reports/tabs";
import { sheetsConfig, syncFinanceSheets } from "@/lib/finance/reports/sheets";
import type { CashEntry, Commitment } from "@/lib/finance/suppliers";

const TODAY = "2026-10-15";
const actor = { id: "apikey:test", name: "Test agent" };
const byKey = (lines: ReturnType<typeof resolveSchedule>) => Object.fromEntries(lines.map((l) => [l.key, l]));
const code = (c: string) => (e: unknown) => e instanceof InvoiceError && e.code === c;

before(async () => {
  setStoreForTests(new MemoryStore());
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON; delete process.env.FINANCE_SHEET_ID;
  await upsertProject({ id: "P1", firstName: "Pat", lastName: "Example", wonValue: 20000, wonDate: "2026-09-01", status: "active", source: { kind: "manual" } }, "test");
});

// ----------------------------------------------------------------- invoices
test("invoice numbers come from SETTINGS#invoice_sequence, per year, never reused", async () => {
  assert.equal(await nextInvoiceNumber("SI", 2030), "SI-2030-0001");
  assert.equal(await nextInvoiceNumber("SI", 2030), "SI-2030-0002");
  assert.equal(await nextInvoiceNumber("SI", 2031), "SI-2031-0001");
});

test("raise → mark paid needs a receipt confirmation; the payment lands on the line", async () => {
  const raised = await raiseScheduleInvoice({ projectId: "P1", scheduleKey: "deposit", actor });
  assert.match(raised.invoice.number, /^SI-\d{4}-\d{4}$/);
  assert.equal(invoiceTotal(raised.invoice), 8400);
  assert.equal(raised.invoice.status, "draft");
  assert.equal(raised.project.orderFinance?.schedule.deposit?.invoiceId, raised.invoice.id);
  assert.equal(raised.emailed, false);
  await assert.rejects(raiseScheduleInvoice({ projectId: "P1", scheduleKey: "deposit", actor }), code("INVOICE_ALREADY_INVOICED"));
  const id = raised.invoice.id;
  await assert.rejects(markInvoicePaid({ projectId: "P1", invoiceId: id, actor, confirmation: null }), code("INVOICE_CONFIRMATION_REQUIRED"));
  await assert.rejects(markInvoicePaid({ projectId: "P1", invoiceId: id, actor, confirmation: { source: "client_said_so" } }), code("INVOICE_CONFIRMATION_INVALID"));
  const paid = await markInvoicePaid({ projectId: "P1", invoiceId: id, actor, paidAt: "2026-10-01", confirmation: { source: "bank_statement", ref: "statement line 12" } });
  assert.equal(paid.invoice.status, "paid");
  assert.equal(paid.payment?.amount, 8400);
  assert.equal(paid.payment?.scheduleKey, "deposit");
  assert.deepEqual({ source: paid.payment?.confirmation?.source, by: paid.payment?.confirmation?.by, ref: paid.payment?.confirmation?.ref }, { source: "bank_statement", by: "Test agent", ref: "statement line 12" });
  assert.equal(byKey(resolveSchedule(paid.project, { today: TODAY })).deposit.status, "paid");
  await assert.rejects(markInvoicePaid({ projectId: "P1", invoiceId: id, actor, confirmation: { source: "owner" } }), code("INVOICE_ALREADY_PAID"));
});

test("record_payment needs a confirmation and flips the settled line's invoice to paid", async () => {
  const survey = await raiseScheduleInvoice({ projectId: "P1", scheduleKey: "survey_payment", actor });
  await assert.rejects(recordPayment({ projectId: "P1", amount: 8400, actor, confirmation: undefined }), code("INVOICE_CONFIRMATION_REQUIRED"));
  const rec = await recordPayment({ projectId: "P1", amount: 8400, scheduleKey: "survey_payment", actor, confirmation: { source: "owner", by: "the owner" } });
  assert.equal(rec.payment.confirmation?.by, "the owner");
  assert.deepEqual(rec.invoicesAutoMarkedPaid, [survey.invoice.number]);
  assert.equal(rec.project.invoices?.find((i) => i.id === survey.invoice.id)?.status, "paid");
});

test("edit / void / delete: amount changes and non-draft deletes are admin-only; a deleted paid invoice takes its auto-recorded payment with it", async () => {
  const project = (await buildFinanceOverview({ ledger: null, pnlLimit: 0 })).invoices;
  const deposit = project.find((r) => r.projectId === "P1" && r.invoice.scheduleKey === "deposit")!.invoice;
  const survey = project.find((r) => r.projectId === "P1" && r.invoice.scheduleKey === "survey_payment")!.invoice;
  await assert.rejects(editInvoice({ projectId: "P1", invoiceId: deposit.id, actor, elevated: true, description: "x" }), code("INVOICE_LOCKED"));
  const balance = await raiseScheduleInvoice({ projectId: "P1", scheduleKey: "delivery_balance", actor });
  await assert.rejects(editInvoice({ projectId: "P1", invoiceId: balance.invoice.id, actor, elevated: false, amountGross: 7000 }), code("INVOICE_FORBIDDEN"));
  const edited = await editInvoice({ projectId: "P1", invoiceId: balance.invoice.id, actor, elevated: true, amountGross: 7000, description: "Delivery balance (agreed)" });
  assert.equal(invoiceTotal(edited.invoice), 7000);
  assert.ok(edited.changed.some((c) => c.startsWith("amount")) && edited.changed.includes("description"));
  assert.equal(byKey(resolveSchedule(edited.project, { today: TODAY })).delivery_balance.amountGross, 7000);
  await assert.rejects(setInvoiceStatus("P1", balance.invoice.id, "void", actor, false), code("INVOICE_FORBIDDEN"));
  const voided = await setInvoiceStatus("P1", balance.invoice.id, "void", actor, true);
  assert.equal(voided.invoice.status, "void");
  await assert.rejects(deleteInvoice({ projectId: "P1", invoiceId: deposit.id, actor, elevated: false }), code("INVOICE_FORBIDDEN"));
  const del = await deleteInvoice({ projectId: "P1", invoiceId: deposit.id, actor, elevated: true });
  assert.equal(del.removedPayments.length, 1);
  assert.equal(del.removedPayments[0].amount, 8400);
  assert.equal(del.project.orderFinance?.schedule.deposit?.invoiceId, null);
  const lines = byKey(resolveSchedule(del.project, { today: TODAY }));
  assert.equal(lines.deposit.status, "overdue");          // the hand-recorded survey receipt stays on its own line
  assert.equal(lines.survey_payment.status, "paid");
  assert.equal(del.project.invoices?.some((i) => i.id === survey.id), true);
});

test("set_order_finance: net value, installation contract and line overrides recalculate the schedule", async () => {
  const r = await setOrderFinance("P1", { netValue: 30000, installation: { value: 4000, retentionApplies: true }, lineOverrides: [{ key: "deposit", pct: 50 }] }, actor);
  assert.equal(r.project.wonValue, 30000);
  const s = byKey(r.schedule);
  assert.equal(s.deposit.amountGross, 18000);
  assert.equal(s.install_deposit.applicable, true);
  assert.equal(s.retention.amountGross, 480);
  const back = await setOrderFinance("P1", { netValue: 20000, installation: null, lineOverrides: [{ key: "deposit", reset: true }] }, actor);
  assert.equal(byKey(back.schedule).deposit.amountGross, 8400);
});

test("reconcileInvoices flags an invoice that differs from its line, a paid-short line and overpayment", () => {
  const inv: Invoice = { id: "I9", number: "SI-2026-0099", date: "2026-09-01", items: [{ description: "Deposit", qty: 1, unitPrice: 6000 }], vatRate: 20, status: "paid", scheduleKey: "deposit" };
  const project = { wonValue: 20000, wonDate: "2026-09-01", orderFinance: { vatRate: 20, schedule: { deposit: { pct: null, amount: null, overridden: false, invoiceId: "I9" } }, installation: null, updatedAt: "" }, surveyOrderAt: null, deliveryDate: null, installStart: null, signOff1At: null, signOff2At: null, stage1Date: null, stage2Date: null, payments: [{ id: "p", amount: 9000, date: "2026-09-02", method: "Card" as const, scheduleKey: "survey_payment" as const }], invoices: [inv] };
  const r = reconcileInvoices(project, { today: TODAY });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.kind === "paid_short" && i.fix === "record_payment"));
  assert.ok(r.issues.some((i) => i.kind === "overpaid" && i.key === "survey_payment"));
  assert.equal(r.order.invoicedGross, 7200);   // the invoiced line takes the invoice total
});

test("overview rolls the projects up and the due windows behave", async () => {
  const o = await buildFinanceOverview({ ledger: null, pnlLimit: 0 });
  assert.equal(o.source, "CRM_UNRECONCILED");
  assert.ok(o.projects >= 1);
  const row = o.collections.find((c) => c.projectId === "P1")!;
  assert.equal(row.gross, 24000);
  assert.equal(row.taken, 8400);
  assert.equal(inWindow({ dueDate: "2026-10-20", status: "due" }, "next7", TODAY), true);
  assert.equal(inWindow({ dueDate: "2026-10-30", status: "upcoming" }, "next7", TODAY), false);
  assert.equal(inWindow({ dueDate: null, status: "tbc" }, "all", TODAY), true);
  assert.equal(inWindow({ dueDate: "2026-09-01", status: "paid" }, "overdue", TODAY), false);
});

// --------------------------------------------------------------- project P&L
const order = (o: Partial<SupplierOrder> & { id: string }): SupplierOrder => ({ reference: o.id, supplierName: "", status: "sent", orderType: "contract", lines: [], createdAt: "2026-09-10T00:00:00Z", ...o });
const costing = { sales: { revenue: 20000, totalCost: 9000, profit: 11000, marginPct: 55, capturedAt: "2026-09-01T00:00:00Z" } };

test("order costs respect the completion cut-off and split post-completion spend", () => {
  const orders = [
    order({ id: "o1", status: "confirmed", orderedNet: 9000 }),
    order({ id: "o2", status: "sent", orderType: "addon", lines: [{ code: "S", description: "Sink", qty: 1, unitCost: 500, unitSell: 800 }], createdAt: "2026-10-01T00:00:00Z" }),
    order({ id: "o3", status: "sent", orderType: "remedial", orderedNet: 300, createdAt: "2026-11-01T00:00:00Z" }),
    order({ id: "o4", status: "sent", orderType: "remedial", orderedNet: 250, createdAt: "2026-12-05T00:00:00Z" }),
    order({ id: "o5", status: "cancelled", orderedNet: 9999 }),
  ];
  const extras = [
    { id: "e1", amount: 120, date: "2026-11-15", category: "Labour" as const, description: "Extra fitter day", addedBy: "x", addedAt: "2026-11-15T00:00:00Z" },
    { id: "e2", amount: 80, date: "2026-12-10", category: "Other" as const, description: "Late skip", addedBy: "x", addedAt: "2026-12-10T00:00:00Z" },
  ];
  const c = liveOrderCosts(orders, extras, { asOf: "2026-12-01T00:00:00Z" });
  assert.deepEqual([c.contractCost, c.addonCost, c.addonSell, c.remedialCost, c.extraCost], [9000, 500, 800, 300, 120]);
  assert.deepEqual(c.postCutoff, { orders: 1, cost: 250, extras: 1, extraCost: 80 });
});

test("P&L comparison: frozen sales, live order, completion only once every supplier has invoiced", () => {
  const p = { wonValue: 20000, extraCosts: null, costing, supplyOnly: null, deliveryDate: null, signOff2At: null, stage2Date: null };
  const orders = [order({ id: "o1", status: "confirmed", orderedNet: 9500 }), order({ id: "o3", status: "sent", orderType: "remedial", orderedNet: 300, createdAt: "2026-11-01T00:00:00Z" })];
  const noLedger = pnlComparison(p, orders);
  assert.equal(noLedger.completion.available, false);
  assert.ok(noLedger.completion.source?.includes("ledger unavailable"));
  assert.equal(noLedger.extraSpend.remedial, 300);
  const nothingPosted = pnlComparison(p, orders, null);
  assert.ok(nothingPosted.completion.source?.includes("Awaiting supplier invoices"));
  const ledger = { classId: "9", className: "Pat Example", net: 9800, docs: 3, vendors: [{ vendor: "Acme Worktops", net: 9800, docs: 3 }], lastTxnDate: "2026-11-02" };
  const unchecked = pnlComparison(p, orders, ledger);
  assert.ok(unchecked.completion.source?.includes("no CRM supplier orders"));
  const cmp = pnlComparison(p, orders.map((o) => ({ ...o, supplierName: "Acme Worktops" })), ledger);
  assert.equal(cmp.sales.frozen, true);
  assert.equal(cmp.sales.profit, 11000);
  assert.equal(cmp.order.frozen, false);
  assert.equal(cmp.order.cost, 9500);
  assert.equal(cmp.completion.available, true);
  assert.equal(cmp.completion.cost, 9800);
  assert.equal(cmp.deltas.salesToOrder?.profit, -500);
  assert.equal(cmp.deltas.orderToCompletion?.cost, 300);
  assert.equal(cmp.postCompletion, null);
  // a frozen order costing from the CRM wins over the live orders
  const frozen = pnlComparison({ ...p, costing: { ...costing, order: { revenue: 20000, totalCost: 9700, profit: 10300, marginPct: 51.5, capturedAt: "2026-09-20T00:00:00Z", note: "survey order costing" } } }, orders);
  assert.equal(frozen.order.frozen, true);
  assert.equal(frozen.order.cost, 9700);
});

test("Completion P&L waits for every supplier, then compares with the acknowledged cost and adds extras", () => {
  const p = { wonValue: 20000, extraCosts: [{ id: "x1", amount: 150, date: "2026-09-20", category: "Labour" as const, description: "Extra fitter day", addedBy: "sk", addedAt: "2026-09-20T00:00:00Z" }], costing: null, supplyOnly: null, deliveryDate: null, signOff2At: null, stage2Date: null };
  const orders = [order({ id: "PO-1", supplierName: "Acme Worktops Ltd", status: "confirmed", orderedNet: 9500 }), order({ id: "PO-2", supplierName: "The Stone Yard", status: "sent", orderedNet: 3000, createdAt: "2026-09-11T00:00:00Z" })];
  const partial = pnlComparison(p, orders, { classId: "9", className: "P E", net: 9650, docs: 2, vendors: [{ vendor: "Acme Worktops", net: 9650, docs: 2 }], lastTxnDate: "2026-10-01" });
  assert.equal(partial.completion.available, false);
  assert.ok(partial.completion.source?.includes("Stone Yard") && partial.completion.source?.includes("1 of 2 suppliers"));
  const done = pnlComparison(p, orders, { classId: "9", className: "P E", net: 12900, docs: 3, vendors: [{ vendor: "Acme Worktops", net: 9650, docs: 2 }, { vendor: "The Stone Yard Ltd", net: 3250, docs: 1 }], lastTxnDate: "2026-10-05" });
  assert.equal(done.completion.available, true);
  assert.equal(done.completion.cost, 13050);
  assert.ok(done.completion.warnings.some((w) => w.includes("+£400.00")));
  assert.equal(done.extraSpend.extra, 150);
  const amb = pnlComparison(p, orders, { classId: "", className: "", net: 0, docs: 0, vendors: [], lastTxnDate: null, ambiguous: ["P E", "P E Joinery"] });
  assert.ok(amb.completion.source?.includes("ambiguous"));
});

test("Supplier P&L: acknowledged prices and extras replace ordered prices; drift and warnings", () => {
  const p = { wonValue: 20000, extraCosts: null, costing: null, supplyOnly: null, deliveryDate: null, signOff2At: null, stage2Date: null };
  const orders = [
    // ordered 9,500, acknowledged 9,740 + 45 carriage → supplier cost 9,785
    order({ id: "PO-2026-AAAAA", supplierName: "Acme Worktops", status: "discrepancy", lines: [{ code: "A1", description: "Unit", qty: 1, unitCost: 9500, position: 1 }], ack: { receivedAt: "2026-09-12T00:00:00Z", status: "discrepancy", discrepancies: [], lines: [{ code: "A1", description: "Unit", qty: 1, unitCost: 9740 }], extras: [{ label: "Carriage", amount: 45 }] } }),
    // with the supplier, no ack yet → ordered price
    order({ id: "PO-2026-BBBBB", supplierName: "Sink Supplies", status: "sent", orderType: "addon", lines: [{ code: "B1", description: "Sink", qty: 1, unitCost: 600, unitSell: 900 }], createdAt: "2026-09-11T00:00:00Z" }),
    order({ id: "o3", status: "sent", orderType: "remedial", orderedNet: 300, createdAt: "2026-11-01T00:00:00Z" }),
  ];
  const t = ackTotals(orders[0]);
  assert.deepEqual([t.orderedCost, t.acknowledgedCost, t.delta, t.extrasTotal, t.coverage.matched], [9500, 9785, 285, 45, 1]);
  // a line missing from the ack is still charged at the ordered price, never dropped
  const partialAck = ackTotals({ lines: [{ code: "A1", description: "", qty: 1, unitCost: 100 }, { code: "A2", description: "", qty: 2, unitCost: 50 }], ack: { receivedAt: "", status: "discrepancy", discrepancies: [], lines: [{ code: "A1", qty: 1, unitCost: 110 }] } });
  assert.deepEqual([partialAck.acknowledgedCost, partialAck.unacknowledgedCost, partialAck.coverage.missing], [210, 100, 1]);
  const cmp = pnlComparison(p, orders);
  assert.equal(cmp.order.cost, 10100);
  assert.equal(cmp.supplier.cost, 10385);
  assert.equal(cmp.deltas.orderToSupplier?.cost, 285);
  assert.equal(cmp.supplierDrift?.delta, 285);
  assert.equal(cmp.supplierDrift?.acknowledgedOrders, 1);
  assert.ok(cmp.supplier.warnings.some((w) => w.includes("PO-2026-BBBBB") && w.includes("not acknowledged")));
  assert.ok(cmp.supplier.warnings.some((w) => w.includes("PO-2026-AAAAA") && w.includes("+£285.00")));
  assert.equal(pnlComparison(p, []).supplier.available, false);
  assert.equal(pnlComparison(p, [orders[1]]).supplierDrift, null);
});

// ------------------------------------------------------------------- ledger
test("ledger aggregation: bills add, vendor credits and credit purchases subtract, per class and vendor", () => {
  const line = (cls: string, amount: number) => ({ Amount: amount, AccountBasedExpenseLineDetail: { ClassRef: { value: cls, name: `Class ${cls}` } } });
  const l = aggregateLedger({
    bills: [{ Id: "1", TxnDate: "2026-09-01", VendorRef: { name: "Acme Worktops" }, Line: [line("9", 100), line("9", 200), { Amount: 50, AccountBasedExpenseLineDetail: {} }] }],
    credits: [{ Id: "2", TxnDate: "2026-09-05", VendorRef: { name: "Acme Worktops" }, Line: [line("9", 50)] }],
    purchases: [{ Id: "3", TxnDate: "2026-09-07", Credit: true, EntityRef: { name: "Card payee" }, Line: [line("9", 10)] }, { Id: "4", TxnDate: "2026-08-01", EntityRef: { name: "Card payee" }, Line: [line("7", 30)] }],
  }, "2025-01-01");
  assert.equal(l.docs, 4);
  assert.equal(l.byClass["9"].net, 240);
  assert.equal(l.byClass["9"].docs, 3);
  assert.deepEqual(l.byClass["9"].vendors.map((v) => [v.vendor, v.net]), [["Acme Worktops", 250], ["Card payee", -10]]);
  assert.deepEqual([l.byClass["9"].firstTxnDate, l.byClass["9"].lastTxnDate], ["2026-09-01", "2026-09-07"]);
  assert.equal(l.byClass["7"].net, 30);
});

test("ledger matching: near-miss class spellings and supplier aliases", () => {
  const classes = [{ classId: "1", className: "Jef and Lisa Shah Joinery" }, { classId: "2", className: "Rhea Patel" }, { classId: "3", className: "Neasa Fitzgerald" }];
  assert.deepEqual(matchClasses("Jeff and Lisa Shaw", classes).map((c) => c.classId), ["1"]);
  assert.deepEqual(matchClasses("Rhea Patel", classes).map((c) => c.classId), ["2"]);
  assert.deepEqual(matchClasses("Mr & Mrs Patel", classes).map((c) => c.classId), ["2"]);
  assert.deepEqual(matchClasses("Mr & Mrs Patel", [...classes, { classId: "4", className: "Deepa Patel" }]).map((c) => c.classId), ["2", "4"]);
  assert.deepEqual(matchClasses("Mr & Mrs Lee", classes).map((c) => c.classId), []);
  assert.equal(vendorMatches("Acme Worktops Ltd", "Acme Worktops"), true);
  assert.equal(vendorMatches("The Stone Yard", "The Stone Yard Ltd"), true);
  assert.equal(vendorMatches("Northern Appliances", "Sink Supplies UK"), false);
  const aliases = supplierAliasIndex([{ vendorName: "Northern Appliances", aliases: ["NORTHCO", "Northern Appliances Ltd"] }, { vendorName: "ACME", aliases: ["Acme Worktops Ltd"] }]);
  assert.equal(vendorMatches("NORTHCO", "Northern Appliances", aliases), true);
  assert.equal(vendorMatches("NORTHCO", "Northern Appliances"), false);
  assert.equal(vendorMatches("Acme Worktops Ltd", "Northern Appliances", aliases), false);
  assert.equal(tokenNear("jeff", "jef"), true);
  assert.equal(tokenNear("shaw", "shah"), true);
  assert.equal(tokenNear("patel", "shah"), false);
  assert.deepEqual(classByCustomerFuzzy({ classes: classes.map((c) => ({ id: c.classId, name: c.className })) }, "Jeff and Lisa Shaw").map((c) => c.id), ["1"]);
});

// ---------------------------------------------------------- QuickBooks reports
test("Vendor Balance Detail: open items, buckets, unapplied credits and disputed / pre-cutoff items", () => {
  const cols = ["Date", "Transaction Type", "Num", "Due Date", "Amount", "Open Balance"].map((ColTitle) => ({ ColTitle }));
  const row = (id: string, date: string, type: string, num: string, due: string, amount: string, open: string) => ({ ColData: [{ value: date, id }, { value: type }, { value: num }, { value: due }, { value: amount }, { value: open }] });
  const raw = { Header: { EndPeriod: TODAY, Currency: "GBP" }, Columns: { Column: cols }, Rows: { Row: [
    { type: "Section", Header: { ColData: [{ value: "Acme Worktops", id: "12" }] }, Rows: { Row: [
      row("b1", "2026-09-01", "Bill", "A-1", "2026-10-01", "100.00", "100.00"),
      row("b2", "2026-09-20", "Bill", "A-2", "2026-10-25", "200.00", "200.00"),
      row("c1", "2026-09-22", "Vendor Credit", "CR-1", "", "-30.00", "-30.00"),
      row("b3", "2025-11-01", "Bill", "OLD", "2025-12-01", "500.00", "500.00"),
    ] }, Summary: { ColData: [{ value: "Total" }] } },
    { type: "Section", Header: { ColData: [{ value: "Sink Supplies", id: "13" }] }, Rows: { Row: [row("b4", "2026-10-10", "Bill", "S-1", "2026-11-20", "80.00", "80.00")] } },
  ] } };
  const r = parseVendorBalanceDetail(raw, "realm", TODAY, { cutoff: "2026-01-01", reason: "", setAt: "", setBy: "", ids: ["b2"], items: [] });
  const acme = r.vendors.find((v) => v.vendor === "Acme Worktops")!;
  assert.deepEqual([acme.open, acme.bills, acme.unapplied, acme.disputed, acme.overdue, acme.nextDue], [770, 100, -30, 700, 100, "2026-10-01"]);
  assert.equal(acme.items.find((i) => i.id === "b1")?.daysOverdue, 14);
  assert.equal(acme.items.find((i) => i.id === "b3")?.disputed, true);
  assert.deepEqual([r.totalBills, r.totalDisputed, r.disputedCount, r.totalUnapplied, r.totalOverdue], [180, 700, 2, -30, 100]);
  assert.deepEqual(r.buckets, { overdue: 100, next7: 0, next14: 0, next30: 0, later: 80, undated: 0 });
  assert.equal(parseVendorBalanceDetail(raw, "realm", TODAY, null).totalBills, 880);
});

test("Profit and Loss parser: groups, summaries and the by-month columns", () => {
  const col = (title: string, start?: string) => ({ ColTitle: title, ColType: "Money", MetaData: start ? [{ Name: "StartDate", Value: start }] : [] });
  const raw = { Columns: { Column: [{ ColTitle: "", ColType: "Account" }, col("Jan 2026", "2026-01-01"), col("Feb 2026", "2026-02-01"), col("Total")] }, Rows: { Row: [
    { type: "Section", group: "Income", Header: { ColData: [{ value: "Income" }] }, Rows: { Row: [{ ColData: [{ value: "Sales", id: "40" }, { value: "1000" }, { value: "2000" }, { value: "3000" }] }] }, Summary: { ColData: [{ value: "Total Income" }, { value: "1,000.00" }, { value: "2000" }, { value: "3000" }] } },
    { type: "Section", group: "COGS", Header: { ColData: [{ value: "Cost of Sales" }] }, Rows: { Row: [{ ColData: [{ value: "Materials" }, { value: "400" }, { value: "800" }, { value: "1200" }] }] }, Summary: { ColData: [{ value: "Total Cost of Sales" }, { value: "400" }, { value: "800" }, { value: "1200" }] } },
    { type: "Section", group: "GrossProfit", Summary: { ColData: [{ value: "Gross Profit" }, { value: "600" }, { value: "1200" }, { value: "1800" }] } },
    { type: "Section", group: "Expenses", Header: { ColData: [{ value: "Expenses" }] }, Rows: { Row: [{ ColData: [{ value: "Rent" }, { value: "100" }, { value: "100" }, { value: "200" }] }] }, Summary: { ColData: [{ value: "Total Expenses" }, { value: "100" }, { value: "100" }, { value: "200" }] } },
    { type: "Section", group: "NetOperatingIncome", Summary: { ColData: [{ value: "Net Operating Income" }, { value: "500" }, { value: "1100" }, { value: "1600" }] } },
    { type: "Section", group: "NetIncome", Summary: { ColData: [{ value: "Net Income" }, { value: "500" }, { value: "1100" }, { value: "1600" }] } },
  ] } };
  const parsed = parseProfitAndLoss(raw);
  assert.equal(parsed.columns.length, 3);
  assert.deepEqual(summariseColumn(parsed, 0), { income: 1000, cogs: 400, grossProfit: 600, expenses: 100, netOperatingIncome: 500, otherExpenses: 0, netIncome: 500 });
  assert.equal(summariseColumn(parsed, 2).netIncome, 1600);
  const months = monthsFromParsed(parsed, 2026, { "2026-01": 2 });
  assert.deepEqual([months[0].income, months[0].deals, months[0].avgGross, months[0].gpPct, months[0].aov], [1000, 2, 300, 60, 500]);
  assert.deepEqual([months[1].income, months[1].avgGross], [2000, null]);
  assert.equal(months[11].income, 0);
  const rows = parsed.rows.map((r) => ({ label: r.label, kind: r.kind, depth: r.depth, group: r.group, amount: r.values[0], pctOfIncome: null }));
  const rep = (labels: string[]): ClassPnl => ({ classId: "1", className: null, start: "", end: "", rows: rows.filter((r) => labels.includes(r.label)), summary: summariseColumn(parsed, 0), source: "QuickBooks ProfitAndLoss?class", fetchedAt: "" });
  assert.deepEqual(mergeRowOrder([rep(["Income", "Sales", "Total Income"]), rep(["Income", "Total Income", "Rent"])]).map((r) => r.label), ["Income", "Sales", "Total Income", "Rent"]);
});

test("project completion date: delivery for supply-only, Stage 2 sign-off, completedAt, inferred fallback", () => {
  const inv = (key: string, status: Invoice["status"], date: string): Invoice => ({ id: key, number: "SI-1", date, items: [{ description: key === "deposit" ? "Deposit due on order" : "Delivery balance", qty: 1, unitPrice: 1 }], vatRate: 20, status, scheduleKey: key as Invoice["scheduleKey"] });
  assert.deepEqual(projectCompletionDate({ supplyOnly: true, deliveryDate: "2026-10-01", stage2Date: null, signOff2At: null, completedAt: null, opsStage: null, invoices: [] }, TODAY), { date: "2026-10-01", source: "deliveryDate" });
  assert.equal(projectCompletionDate({ supplyOnly: true, deliveryDate: "2026-11-01", stage2Date: null, signOff2At: null, completedAt: null, opsStage: null, invoices: [] }, TODAY), null);
  assert.deepEqual(projectCompletionDate({ supplyOnly: false, deliveryDate: null, stage2Date: "2026-09-30T10:00:00Z", signOff2At: null, completedAt: null, opsStage: null, invoices: [] }, TODAY), { date: "2026-09-30", source: "stage2Date" });
  assert.deepEqual(projectCompletionDate({ supplyOnly: false, deliveryDate: null, stage2Date: null, signOff2At: null, completedAt: "2026-10-02", opsStage: null, invoices: [] }, TODAY), { date: "2026-10-02", source: "completedAt" });
  assert.deepEqual(projectCompletionDate({ supplyOnly: false, deliveryDate: null, stage2Date: null, signOff2At: null, completedAt: null, opsStage: "Stage 2", invoices: [inv("delivery_balance", "sent", "2026-10-03")] }, TODAY), { date: "2026-10-03", source: "fallback" });
  assert.equal(projectCompletionDate({ supplyOnly: false, deliveryDate: null, stage2Date: null, signOff2At: null, completedAt: null, opsStage: "Stage 2", invoices: [inv("deposit", "sent", "2026-10-03")] }, TODAY), null);
  assert.equal(hasFinalInvoice({ invoices: [inv("delivery_balance", "draft", "2026-10-03")] }), false);
});

// ----------------------------------------------------------------- cashflow
test("cashflow: age buckets and the 13-week projection (overdue lands in week 1, undated excluded)", () => {
  assert.deepEqual(["2026-10-01", "2026-10-20", "2026-10-28", "2026-11-10", "2027-01-01", null].map((d) => bucketFor(d, TODAY)), ["overdue", "next7", "next14", "next30", "later", "undated"]);
  const weeks = projectWeeks(TODAY, 1000, [{ dueDate: "2026-10-10", amount: 500 }, { dueDate: "2026-10-25", amount: 300 }, { dueDate: null, amount: 999 }], [{ date: "2026-10-16", amount: 200 }], [{ date: "2026-11-01", amount: 100 }]);
  assert.equal(weeks.length, 13);
  assert.deepEqual([weeks[0].inbound, weeks[0].outbound, weeks[0].closing, weeks[0].inboundLines], [500, 200, 1300, 1]);
  assert.deepEqual([weeks[1].inbound, weeks[1].closing], [300, 1600]);
  assert.deepEqual([weeks[2].commitments, weeks[2].closing], [100, 1500]);
  assert.equal(weeks[12].closing, 1500);
});

// --------------------------------------------------------------- commission
test("commission: config in the store, floor tier lookup, the payable split and holds", async () => {
  await assert.rejects(setCommissionConfig({ designer: "ab", split: { now: 70, later: 40 } }, "test"), (e: Error) => e.message === "COMMISSION_SPLIT_MUST_SUM_100");
  const cfg = await setCommissionConfig({ designer: "ab", displayName: "Designer A", match: ["designer a"], tiers: [[40, 10], [30, 5], [35, 6]], split: { now: 60, later: 40 }, minSalesPerMonth: 3, laterRule: "one month after completion" }, "test");
  assert.deepEqual(cfg.designers.ab.tiers, [[30, 5], [35, 6], [40, 10]]);
  assert.equal((await getCommissionConfig()).designers.ab.displayName, "Designer A");
  const tiers = cfg.designers.ab.tiers;
  assert.deepEqual([tierPct(tiers, 29.9), tierPct(tiers, 30), tierPct(tiers, 37.5), tierPct(tiers, 55), tierPct(null, 40), tierPct(tiers, null)], [0, 5, 6, 10, null, null]);
  const base = { projectId: "P1", client: "Pat Example", classId: "9", className: "Pat Example", completionDate: "2026-09-30", completionSource: "stage2Date" as const, hasFinalInvoice: true, remedialsOpen: false, ambiguous: [], error: null };
  const line = commissionLine(cfg.designers.ab, base, { income: 20000, profit: 7500, source: "qbo_class", note: "QuickBooks" });
  assert.deepEqual([line.profitPct, line.commPct, line.commission, line.payableNow, line.payableLater, line.payableLaterDate, line.holds], [37.5, 6, 450, 270, 180, "2026-10-30", []]);
  const held = commissionLine(cfg.designers.ab, { ...base, hasFinalInvoice: false, remedialsOpen: true, completionSource: "fallback" }, { income: 20000, profit: 5000, source: "crm", note: "CRM" });
  assert.deepEqual(held.holds, ["class_not_matched", "no_final_invoice", "remedials_open", "below_lowest_tier"]);
  assert.equal(held.commission, 0);
  const unknown = commissionLine({ ...cfg.designers.ab, tiers: null }, base, null);
  assert.ok(unknown.holds.includes("no_profit_data") && unknown.holds.includes("tiers_unknown"));
  assert.equal(unknown.commission, null);
  assert.deepEqual(commissionMonths("2026-10"), ["2026-08", "2026-09", "2026-10"]);
  assert.equal(addMonth("2026-01-31"), "2026-02-28");
});

// ------------------------------------------------------------------ reports
test("report tabs: CSV, A1 slicing, loans, cash control and the P&L by Month block", () => {
  assert.equal(toCsv([["a", 1, null], ['say "hi", now', true, 2.5]]), 'a,1,\n"say ""hi"", now",true,2.5');
  assert.deepEqual(sliceA1([[1, 2, 3], [4, 5, 6], [7, 8, 9]], "B2:C3"), [[5, 6], [8, 9]]);
  assert.deepEqual(sliceA1([[1, 2, 3]], "'Cashflow'!A1"), [[1]]);
  const loan: Commitment = { id: "loan-x", kind: "loan", name: "Term loan", amount: 1200, frequency: "monthly", dueDay: 5, nextDue: null, balance: 24000, endDate: "2028-06-05", notes: "", active: true, updatedBy: "t", updatedAt: "" };
  const rent: Commitment = { ...loan, id: "overhead-rent", kind: "overhead", name: "Rent", amount: 3000, balance: null, dueDay: 1 };
  const loans = loansMatrix([loan, rent], TODAY);
  assert.deepEqual(loans.matrix[1].slice(0, 4), ["Term loan", 24000, "05/06/2028", 1200]);
  assert.deepEqual(loans.matrix[2].slice(0, 4), ["Total", 24000, "", 1200]);
  assert.equal(loans.matrix[1][6], "05/11/2026");
  assert.equal(loans.matrix[4][0], "Other standing commitments");
  assert.equal(loans.matrix[6][0], "Rent");
  const entries: CashEntry[] = [
    { id: "e1", date: "2026-10-01", section: "other_in", label: "Director loan", amount: 5000, note: null, source: "owner", confirmed: true, createdBy: "o", createdAt: "2026-10-01T00:00:00Z" },
    { id: "e2", date: "2026-10-03", section: "other_out", label: "Equipment", amount: 1250.5, note: "van", source: "agent", confirmed: false, createdBy: "a", createdAt: "2026-10-03T00:00:00Z" },
    { id: "e3", date: "2026-10-03", section: "supplier", label: "Acme", amount: 99, note: null, source: "agent", confirmed: true, createdBy: "a", createdAt: "" },
  ];
  const cc = cashControlMatrix(entries);
  assert.equal(cc.matrix.length, 3);
  assert.deepEqual(cc.matrix[2].slice(3, 6), [1250.5, null, 3749.5]);
  const m = (month: string, income: number) => ({ month, label: month, income, cogs: income / 2, grossProfit: income / 2, expenses: 0, netOperatingIncome: income / 2, netProfit: income / 2, deals: income ? 1 : 0, avgGross: income ? income / 2 : null, gpPct: income ? 50 : null, avgNet: income ? income / 2 : null, npPct: income ? 50 : null, aov: income || null });
  const months = Array.from({ length: 12 }, (_, i) => m(`2026-${String(i + 1).padStart(2, "0")}`, i < 2 ? 1000 : 0));
  const total = { label: "Total" as const, income: 2000, cogs: 1000, grossProfit: 1000, expenses: 0, netOperatingIncome: 1000, netProfit: 1000, deals: 2, avgGross: 500, gpPct: 50, avgNet: 500, npPct: 50, aov: 1000 };
  const rep = { year: 2026, source: "QuickBooks ProfitAndLoss by Month (accrual)" as const, months, total, delivered: months, deliveredTotal: total, deliveredSource: "QuickBooks ProfitAndLoss?class for projects completed in the month (CRM completion dates)" as const, fetchedAt: "" };
  const tab = pnlMonthMatrix(rep, null);
  assert.deepEqual(tab.matrix[5].slice(0, 5), ["2026-01", 1000, 500, 500, 1]);
  assert.deepEqual(tab.matrix[17].slice(0, 5), ["Total", 2000, 1000, 1000, 2]);
  assert.deepEqual(tab.matrix[18].slice(0, 3), ["Average / month", 1000, 500]);
});

test("cashflow tab: opening balance, dated receipts and bills roll into the closing row; colours mark due-soon and confirmed cells", () => {
  const outlook: CashflowOutlook = {
    asOf: TODAY, fetchedAt: "",
    bank: { accounts: [{ id: "1", name: "Current account", type: "Bank", subType: null, currency: "GBP", balance: 1000 }, { id: "2", name: "Business card", type: "Credit Card", subType: null, currency: "GBP", balance: -400 }], cash: 1000, creditCards: -400, net: 600, source: "" },
    inbound: { total: 500, byStage: { deposit: 500, survey: 0, delivery_balance: 0, installation: 0, retention: 0 }, buckets: { overdue: 0, next7: 500, next14: 0, next30: 0, later: 0, undated: 0 }, lines: [{ projectId: "P1", client: "Pat Example", designer: null, stage: "deposit", label: "Deposit", amount: 500, dueDate: "2026-10-18", status: "due", invoiceNumber: "SI-2026-0001", bucket: "next7" }], source: "" },
    outbound: { total: 200, overdue: 0, buckets: { overdue: 0, next7: 200, next14: 0, next30: 0, later: 0, undated: 0 }, underReview: 0, unapplied: 0, suppliers: [{ vendor: "Acme Worktops", vendorId: "12", open: 200, overdue: 0, disputed: 0, maxDaysOverdue: 0, nextDue: "2026-10-17", payFriday: "2026-10-23", blockAfterDaysOverdue: null, blockRisk: false, onHold: false, proformaOnly: false, pressure: null, paymentMethods: null }], source: "" },
    commitments: { total90: 0, items: [], source: "" }, position: { available: 1000, in30: 500, out30: 200, projected30: 1300, low: null }, weeks: [], notes: ["note one"],
  };
  const vendors = { source: "QuickBooks Vendor Balance Detail" as const, realm: "r", asOf: TODAY, reportDate: null, currency: "GBP", columns: [], totalOpen: 200, totalBills: 200, totalUnapplied: 0, totalDisputed: 0, disputedCount: 0, disputeCutoff: null, totalOverdue: 0, buckets: { overdue: 0, next7: 200, next14: 0, next30: 0, later: 0, undated: 0 }, vendors: [{ vendor: "Acme Worktops", vendorId: "12", open: 200, bills: 200, unapplied: 0, disputed: 0, overdue: 0, nextDue: "2026-10-17", items: [{ id: "b1", date: "2026-09-17", type: "Bill", num: "A-1", dueDate: "2026-10-17", amount: 200, openBalance: 200, daysOverdue: null, disputed: false }] }], fetchedAt: "" };
  const entries: CashEntry[] = [{ id: "e", date: "2026-10-20", section: "supplier", label: "Acme Worktops", amount: 150, note: null, source: "agent", confirmed: true, createdBy: "a", createdAt: "" }];
  const t = cashflowMatrix({ outlook, vendors, commitments: [], entries, today: TODAY });
  assert.equal(t.matrix[5][1], 1000);
  const closing = t.matrix[t.closingRow];
  assert.equal(closing[1], 1300);                                     // 1000 + 500 − 200 (the confirmed 150 replaced 150 of the projected bill)
  assert.equal(closing[t.firstDayCol + 2], 950);                      // the remaining 50 of the bill on the 17th
  assert.equal(closing[t.firstDayCol + 3], 1450);                     // after the deposit on the 18th
  const acme = t.matrix.find((r) => String(r[0]).trim() === "Acme Worktops")!;
  assert.equal(acme[t.firstDayCol + 2], 50);                          // 200 projected on the 17th, less the 150 confirmed on the 20th
  assert.equal(acme[t.firstDayCol + 5], 150);
  assert.ok(t.colours.some((c) => c.colour === "green") && t.colours.some((c) => c.colour === "yellow"));
  assert.ok(t.matrix.some((r) => r[0] === "note one"));
});

test("Google Sheets is optional: without credentials every entry point says 'not configured'", async () => {
  assert.equal(sheetsConfig().configured, false);
  const r = await syncFinanceSheets({ by: "test" });
  assert.equal(r.configured, false);
  assert.ok(r.note?.includes("not configured"));
  assert.deepEqual(r.results, []);
});
