// Registry of in-memory caches the finance modules keep, so a QuickBooks write
// or webhook can drop them all at once.
const invalidators: (() => void)[] = [];
export function registerCache(fn: () => void) { invalidators.push(fn); }
export function invalidateFinanceCaches() { for (const fn of invalidators) { try { fn(); } catch { /* ignore */ } } }
