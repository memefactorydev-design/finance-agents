import { redirect } from "next/navigation";
import { setupState } from "@/lib/core/setup";
export const dynamic = "force-dynamic";
export default async function Home() {
  const s = await setupState();
  redirect(s.ready ? "/finance" : "/setup");
}
