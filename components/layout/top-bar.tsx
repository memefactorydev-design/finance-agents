"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Landmark, FolderKanban, MessageSquare, Settings, LogOut, Menu, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./theme-toggle";

const NAV = [
  { href: "/finance", label: "Finance", icon: Landmark },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/briefs", label: "Briefs", icon: MessageSquare },
  { href: "/setup", label: "Setup", icon: Settings },
] as const;

export function TopBar({ user, companyName }: { user: { name: string; email: string } | null; companyName?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const signOut = async () => {
    setBusy(true);
    try { await fetch("/api/auth/logout", { method: "POST" }); router.replace("/login"); router.refresh(); }
    catch { toast.error("Could not sign out"); setBusy(false); }
  };
  const active = (href: string) => pathname === href || pathname.startsWith(href + "/");
  return (
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
        <Link href="/finance" className="flex items-center gap-2 font-display text-base font-bold tracking-tight">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Landmark className="h-4 w-4" /></span>
          <span className="hidden sm:inline">{companyName || "Finance Agents"}</span>
        </Link>
        <nav className="ml-2 hidden items-center gap-1 md:flex" aria-label="Primary">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors", active(n.href) ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
              <n.icon className="h-4 w-4" /> {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle />
          {user ? (
            <>
              <span className="hidden text-xs text-muted-foreground lg:inline" title={user.email}>{user.name || user.email}</span>
              <Button variant="ghost" size="sm" className="hidden gap-1.5 md:inline-flex" onClick={signOut} disabled={busy}><LogOut className="h-4 w-4" /> Sign out</Button>
            </>
          ) : (
            <Button asChild variant="outline" size="sm" className="hidden md:inline-flex"><Link href="/login">Sign in</Link></Button>
          )}
          <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}</Button>
        </div>
      </div>
      {open ? (
        <div className="border-t px-4 py-2 md:hidden">
          <nav className="grid gap-1" aria-label="Primary mobile">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} onClick={() => setOpen(false)} className={cn("flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium", active(n.href) ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")}>
                <n.icon className="h-4 w-4" /> {n.label}
              </Link>
            ))}
            {user ? (
              <button type="button" onClick={signOut} disabled={busy} className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-muted-foreground hover:bg-muted"><LogOut className="h-4 w-4" /> Sign out {user.name ? `(${user.name})` : ""}</button>
            ) : (
              <Link href="/login" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted">Sign in</Link>
            )}
          </nav>
        </div>
      ) : null}
    </header>
  );
}
