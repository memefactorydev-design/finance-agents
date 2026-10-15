#!/usr/bin/env tsx
// Local scheduler for installs that are not on Vercel: calls the cron
// endpoint on a timetable. Run with `npm run scheduler` next to `npm run dev`.
import { readFileSync, existsSync } from "node:fs";
const env = Object.fromEntries((existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const base = (process.env.APP_URL || env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
const secret = process.env.CRON_SECRET || env.CRON_SECRET || "";
const jobs: { name: string; everyMinutes: number; last: number }[] = [
  { name: "intake", everyMinutes: 15, last: 0 },
  { name: "orders", everyMinutes: 30, last: 0 },
  { name: "qbo", everyMinutes: 15, last: 0 },
  { name: "crm-sync", everyMinutes: 30, last: 0 },
];
async function run(name: string) {
  const r = await fetch(`${base}/api/cron?job=${name}`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
  const j = await r.json().catch(() => ({}));
  console.log(new Date().toISOString(), name, r.status, JSON.stringify(j).slice(0, 300));
}
console.log(`scheduler → ${base} (${jobs.map((j) => `${j.name}/${j.everyMinutes}m`).join(", ")})`);
setInterval(async () => {
  const now = Date.now();
  for (const j of jobs) if (now - j.last >= j.everyMinutes * 60_000) { j.last = now; run(j.name).catch((e) => console.error(j.name, e)); }
}, 30_000);
