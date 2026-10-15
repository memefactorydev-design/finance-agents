// Server shell for the signed-in pages: checks the owner session, then
// renders the top bar and a 16px-gutter content column. Without a session the
// visitor goes to /login (or to /setup when no owner exists yet).
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/core/auth";
import { setupState } from "@/lib/core/setup";
import { CompanyProvider } from "@/components/use-api";
import { TopBar } from "./top-bar";

export async function AppShell({ children, next }: { children: React.ReactNode; next: string }) {
  const user = await currentUser().catch(() => null);
  if (!user) {
    const s = await setupState().catch(() => null);
    redirect(s && !s.ownerSet ? "/setup" : `/login?next=${encodeURIComponent(next)}`);
  }
  return (
    <CompanyProvider>
      <TopBar user={{ name: user.name, email: user.id }} />
      <main className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-6">{children}</main>
    </CompanyProvider>
  );
}
