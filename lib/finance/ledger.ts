// STUB — replaced by the cashflow/P&L module port (supplier invoices per
// QuickBooks class, the Completion P&L basis).
export interface LedgerCostsByClass { since: string; byClass: Record<string, { classId: string; className: string; net: number; docs: number; vendors: { vendor: string; net: number; docs: number }[]; firstTxnDate: string | null; lastTxnDate: string | null }>; docs: number; fetchedAt: string; source: string }
export async function ledgerCostsByClass(_opts: { fresh?: boolean; maxAgeMs?: number } = {}): Promise<LedgerCostsByClass> {
  return { since: "", byClass: {}, docs: 0, fetchedAt: new Date().toISOString(), source: "not implemented" };
}
