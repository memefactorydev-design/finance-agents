import { AppShell } from "@/components/layout/app-shell";
export const dynamic = "force-dynamic";
export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  return <AppShell next="/finance">{children}</AppShell>;
}
