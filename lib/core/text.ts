// Name normalisation shared by supplier, class and account matching across
// QuickBooks, the CRM connector and invoice text. Dependency-free.
export const normName = (s: string) =>
  (s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(ltd|limited|uk|plc|the|company|co|inc|llc|distribution|distributors|kitchens|systems|trading|group|gmbh)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const slug = (s: string) => normName(s).replace(/\s+/g, "-").slice(0, 60);

export const TIMEZONE = process.env.FINANCE_TIMEZONE || "Europe/London";
export const localDate = (d = new Date(), timeZone = TIMEZONE) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const londonDate = localDate;

export const shiftDays = (iso: string, days: number) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// Next Friday on or after the given date (supplier payments go out on Fridays).
export const nextFriday = (iso: string) => {
  const d = new Date(iso + "T00:00:00Z");
  const delta = (5 - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

export const domainOf = (email: string | null | undefined) => (email || "").toLowerCase().split("@")[1] || null;
export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
