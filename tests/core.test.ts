import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore, MemoryStore, Conflict, all, upsert } from "../lib/core/store";
import { AesGcmCipher, hashPassword, verifyPassword } from "../lib/core/crypto";
import { resolveSchedule, scheduleTotals, contractGross, FINANCE_DEFAULTS } from "../lib/crm/schedule";
import { normaliseIncomingProject } from "../lib/crm/mapping";
import { tokenNear, vendorByName, classByCustomerFuzzy, vatKindFor } from "../lib/qbo/client";
import { dueFor, parseTerm } from "../lib/finance/terms";
import { commitmentDates } from "../lib/finance/suppliers";

test("file store: optimistic versions and conflicts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fa-"));
  const store = new FileStore(join(dir, "store.json"));
  await store.transact("c", [{ key: "A#1", expected: null, data: { v: 1 } }]);
  const row = await store.get<{ v: number }>("c", "A#1");
  assert.equal(row?.version, 1);
  await assert.rejects(store.transact("c", [{ key: "A#1", expected: null, data: { v: 2 } }]), Conflict);
  await store.transact("c", [{ key: "A#1", expected: 1, data: { v: 2 } }, { key: "A#2", expected: null, data: { v: 3 } }]);
  assert.equal((await all(store, "c", "A#")).length, 2);
  const u = await upsert<{ v: number }>(store, "c", "A#1", (cur) => ({ v: (cur?.v ?? 0) + 10 }));
  assert.equal(u.v, 12);
  assert.equal((await store.list("other", "A#")).rows.length, 0);
});

test("memory store pagination", async () => {
  const s = new MemoryStore();
  for (let i = 0; i < 7; i++) await s.transact("c", [{ key: `K#${i}`, expected: null, data: i }]);
  const p1 = await s.list("c", "K#", undefined, 3);
  assert.equal(p1.rows.length, 3); assert.ok(p1.cursor);
  const p2 = await s.list("c", "K#", p1.cursor, 3);
  assert.equal(p2.rows[0].key, "K#3");
});

test("cipher round-trips and binds to the company", async () => {
  const c = new AesGcmCipher(Buffer.alloc(32, 7));
  const ct = await c.encrypt("acme", JSON.stringify({ token: "x" }));
  assert.equal(await c.decrypt("acme", ct), JSON.stringify({ token: "x" }));
  await assert.rejects(c.decrypt("other", ct));
  const h = hashPassword("correct horse battery");
  assert.ok(verifyPassword("correct horse battery", h));
  assert.ok(!verifyPassword("wrong", h));
});

test("schedule: 35/35/balance on the order, installation deposit then 50/50 with retention", () => {
  const p = { wonValue: 10000, wonDate: "2026-01-10", orderFinance: { vatRate: 20, schedule: {}, installation: { value: 2000, retentionApplies: true }, updatedAt: "" }, surveyOrderAt: "2026-02-01", deliveryDate: "2026-03-20", installStart: "2026-03-25", signOff1At: null, signOff2At: null, stage1Date: null, stage2Date: null, payments: [{ id: "p1", amount: 4200, date: "2026-01-11", method: "Bank Transfer" as const, scheduleKey: "deposit" as const }], invoices: [] };
  const lines = resolveSchedule(p, { today: "2026-02-10" });
  const by = Object.fromEntries(lines.map((l) => [l.key, l]));
  assert.equal(contractGross(p), 14400);
  assert.equal(by.deposit.amountGross, 4200); assert.equal(by.deposit.status, "paid");
  assert.equal(by.survey_payment.amountGross, 4200); assert.equal(by.survey_payment.status, "overdue");
  assert.equal(by.delivery_balance.amountGross, 3600); assert.equal(by.delivery_balance.dueDate, "2026-03-06");
  assert.equal(by.install_deposit.amountGross, 480);
  assert.equal(by.install_day1.amountGross, 960);
  assert.equal(by.retention.amountGross, 240);
  assert.equal(by.install_stage1.amountGross, 720);
  const t = scheduleTotals(lines);
  assert.equal(t.totalGross, 14400); assert.equal(t.paidGross, 4200); assert.equal(t.overdueGross, 4680); // survey payment + installation deposit (due on the order date)
  assert.equal(FINANCE_DEFAULTS.depositPct, 35);
});

test("mapping: common CRM payloads normalise to a project", () => {
  const p = normaliseIncomingProject({ id: "D-1", customer: "Jane Smith", email: "jane@example.com", value: "12,500.00", stage: "Won", closeDate: "2026-03-01T10:00:00Z", orders: [{ reference: "PO-7", supplier: "Acme Worktops", lines: [{ code: "W1", qty: 2, cost: "100" }] }] }, {});
  assert.equal(p.firstName, "Jane"); assert.equal(p.lastName, "Smith");
  assert.equal(p.wonValue, 12500); assert.equal(p.wonDate, "2026-03-01"); assert.equal(p.status, "active");
  assert.equal(p.supplierOrders?.[0].reference, "PO-7"); assert.equal(p.supplierOrders?.[0].lines[0].unitCost, 100);
  const m = normaliseIncomingProject({ data: { client_name: "Bob Jones" }, deal: { amount: 500 } }, { name: "data.client_name", wonValue: "deal.amount" });
  assert.equal(m.lastName, "Jones"); assert.equal(m.wonValue, 500);
});

test("qbo matching helpers", () => {
  assert.ok(tokenNear("jeff", "jef")); assert.ok(tokenNear("shaw", "shah")); assert.ok(!tokenNear("smith", "jones"));
  const ref = { vendors: [{ id: "1", name: "Acme Worktops Ltd", email: null, termId: null, active: true }, { id: "2", name: "Bora Holding GmbH", email: null, termId: null, active: true }], classes: [{ id: "c1", name: "Jef and Lisa Shah Joinery" }] };
  assert.equal(vendorByName(ref, "acme worktops ltd").score, 1);
  assert.equal(vendorByName(ref, "BORA Holding GmbH, Innstrasse 1, Austria").vendor?.id, "2");
  assert.equal(classByCustomerFuzzy(ref, "Jeff and Lisa Shaw")[0]?.id, "c1");
  assert.equal(vatKindFor(100, 20), "standard"); assert.equal(vatKindFor(100, 0), "zero"); assert.equal(vatKindFor(100, 5), null);
});

test("terms and commitments", () => {
  assert.deepEqual(parseTerm("Net 30"), { name: "Net 30", kind: "days", days: 30 });
  assert.equal(dueFor("2026-01-15", { name: "", kind: "eom_next", days: 0 }), "2026-02-28");
  assert.equal(dueFor("2026-01-15", { name: "", kind: "days", days: 30 }), "2026-02-14");
  const c = { id: "x", kind: "loan" as const, name: "Loan", amount: 100, frequency: "monthly" as const, dueDay: 31, nextDue: null, balance: null, endDate: null, notes: "", active: true, updatedBy: "", updatedAt: "" };
  assert.deepEqual(commitmentDates(c, "2026-02-01", "2026-03-31"), ["2026-02-28", "2026-03-31"]);
});
