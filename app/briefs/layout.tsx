import { AppShell } from "@/components/layout/app-shell";
export const dynamic = "force-dynamic";
export default function BriefsLayout({ children }: { children: React.ReactNode }) {
  return <AppShell next="/briefs">{children}</AppShell>;
}
