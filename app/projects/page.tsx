import { Suspense } from "react";
import { ProjectList } from "@/components/finance/project-list";
export const dynamic = "force-dynamic";
export default function ProjectsPage() {
  return <Suspense fallback={<p className="text-sm text-muted-foreground">Loading projects…</p>}><ProjectList /></Suspense>;
}
