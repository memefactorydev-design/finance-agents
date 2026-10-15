import { AppShell } from "@/components/layout/app-shell";
export const dynamic = "force-dynamic";
export default function ProjectsLayout({ children }: { children: React.ReactNode }) {
  return <AppShell next="/projects">{children}</AppShell>;
}
