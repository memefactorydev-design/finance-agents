// Keeps the QuickBooks ledger copy (Completion P&L basis) warm.
import { ledgerCostsByClass } from "./ledger";
export async function ledgerWarm(): Promise<unknown> {
  const l = await ledgerCostsByClass({ maxAgeMs: 50 * 60_000 });
  return { docs: l.docs, classes: Object.keys(l.byClass).length, fetchedAt: l.fetchedAt };
}
