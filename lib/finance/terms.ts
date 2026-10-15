// Supplier payment terms (pure): "Net 30" / "30 days" / "end of following month".
export type TermSpec = { name: string; kind: "eom_next" | "days"; days: number };
export function parseTerm(raw: string): TermSpec | null {
  const s = (raw || "").trim().toLowerCase();
  const m = s.match(/(\d+)\s*days?/) || s.match(/^net\s*(\d+)$/);
  if (m) { const days = parseInt(m[1], 10); return { name: `Net ${days}`, kind: "days", days }; }
  if (/month|eom|end of/.test(s)) return { name: "End of following month", kind: "eom_next", days: 0 };
  return null;
}
export function dueFor(txnDate: string, t: TermSpec): string {
  const d = new Date(txnDate + "T00:00:00Z");
  if (t.kind === "days") { d.setUTCDate(d.getUTCDate() + t.days); return d.toISOString().slice(0, 10); }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0)).toISOString().slice(0, 10);
}
