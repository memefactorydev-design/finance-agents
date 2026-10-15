import { Suspense } from "react";
import { BriefsChannel } from "@/components/finance/briefs-channel";
import { TasksPanel } from "@/components/finance/tasks-panel";
export const dynamic = "force-dynamic";
export default function BriefsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Briefs</h1>
        <p className="text-sm text-muted-foreground">The channel the agents report to, and the tasks they leave for a human. Replies here are read on the next run.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading channel…</p>}><BriefsChannel /></Suspense>
        <TasksPanel />
      </div>
    </div>
  );
}
