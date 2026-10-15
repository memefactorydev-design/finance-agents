// Pure helpers the client needs for money and dates. The schedule maths
// itself stays on the server (lib/crm/schedule pulls node:crypto through
// lib/core/domain), so pages read resolved lines from the API; these are the
// handful of formulas that are safe to duplicate.
import type { Invoice, Payment, ScheduleKey } from "@/lib/crm/types";

export const r2 = (v: number) => Math.round(v * 100) / 100;
export const invoiceNet = (inv: Invoice) => r2(inv.items.reduce((s, i) => s + i.qty * i.unitPrice, 0));
export const invoiceVat = (inv: Invoice) => r2(invoiceNet(inv) * (inv.vatRate / 100));
export const invoiceTotal = (inv: Invoice) => r2(invoiceNet(inv) + invoiceVat(inv));
export const netFromGross = (gross: number, vatRate: number) => r2(gross / (1 + vatRate / 100));
export const grossFromNet = (net: number, vatRate: number) => r2(net * (1 + vatRate / 100));
export const paymentsTaken = (payments?: Payment[] | null) => r2((payments || []).reduce((s, p) => s + (p.amount || 0), 0));

export const SCHEDULE_LABEL: Record<ScheduleKey, string> = {
  deposit: "Deposit", survey_payment: "Survey payment", delivery_balance: "Delivery balance",
  install_deposit: "Installation deposit", install_day1: "Due Day 1", install_stage1: "Due on Stage 1 sign-off", retention: "Retention",
};

export const todayIso = () => new Date().toISOString().slice(0, 10);
export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso.length === 10 ? iso + "T00:00:00" : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" }) : "—");
export const fmtDay = (iso: string | null | undefined) => (iso ? new Date(iso.length === 10 ? iso + "T00:00:00" : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "—");
export const fmtWhen = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—");
export const ago = (iso: string) => {
  const d = new Date(iso); const diff = (Date.now() - d.getTime()) / 60_000;
  if (diff < 1) return "just now";
  if (diff < 60) return `${Math.round(diff)} min ago`;
  if (diff < 36 * 60) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + (d.toDateString() === new Date().toDateString() ? "" : " yesterday");
  return fmtWhen(iso);
};
export const pct = (n: number) => `${Math.round(n * 100)}%`;
export const pretty = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
export const personName = (email: string | null | undefined) => (email ? email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Unassigned");
