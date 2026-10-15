import { Suspense } from "react";
import { SetupWizard } from "@/components/setup/wizard";
export const dynamic = "force-dynamic";
// No server-side auth guard here: the Owner step must work before any login
// exists. Every later step calls the API, which enforces the session.
export default function SetupPage() {
  return <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading setup…</p>}><SetupWizard /></Suspense>;
}
