import { ProjectDetail } from "@/components/finance/project-detail";
export const dynamic = "force-dynamic";
// Next 14: params is synchronous.
export default function ProjectPage({ params }: { params: { id: string } }) {
  return <ProjectDetail id={decodeURIComponent(params.id)} />;
}
