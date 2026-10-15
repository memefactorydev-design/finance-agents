import { Suspense } from "react";
import { FinanceDashboard } from "@/components/finance/finance-dashboard";
export const dynamic = "force-dynamic";
// useSearchParams inside the dashboard needs a Suspense boundary (Next 14).
export default function FinancePage() {
  return <Suspense fallback={<p className="text-sm text-muted-foreground">Loading finance…</p>}><FinanceDashboard /></Suspense>;
}
