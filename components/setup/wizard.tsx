"use client";

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { UserRound, Building2, Link2, Inbox, FolderSync, Sparkles, Bell, Bot, Check, Lock } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useApi } from "@/components/use-api";
import { TopBar } from "@/components/layout/top-bar";
import { EnvProvider, type SetupResponse, type StepProps } from "./fields";
import { ErrorNote } from "@/components/finance/section";
import { OwnerStep } from "./steps/owner-step";
import { CompanyStep } from "./steps/company-step";
import { QuickBooksStep } from "./steps/quickbooks-step";
import { MailboxesStep } from "./steps/mailboxes-step";
import { CrmStep } from "./steps/crm-step";
import { AiStep } from "./steps/ai-step";
import { NotificationsStep } from "./steps/notifications-step";
import { AgentsStep } from "./steps/agents-step";

// Onboarding wizard. The Owner step works before any login (it creates the
// login); every later step needs the owner session, which the API enforces.
// Progress is stored with the connections (setup.completedSteps).
const STEPS = [
  { id: "owner", label: "Owner", blurb: "Your login", icon: UserRound, Component: OwnerStep },
  { id: "company", label: "Company", blurb: "Name, currency, approvers, payment split", icon: Building2, Component: CompanyStep },
  { id: "quickbooks", label: "QuickBooks", blurb: "Your Intuit app or Composio", icon: Link2, Component: QuickBooksStep },
  { id: "mailboxes", label: "Mailboxes", blurb: "Intake, orders and accounts mailboxes", icon: Inbox, Component: MailboxesStep },
  { id: "crm", label: "CRM", blurb: "Where projects come from", icon: FolderSync, Component: CrmStep },
  { id: "ai", label: "AI", blurb: "Invoice extraction keys", icon: Sparkles, Component: AiStep },
  { id: "notifications", label: "Notifications", blurb: "Slack mirror of the briefs", icon: Bell, Component: NotificationsStep },
  { id: "agents", label: "Agents & API key", blurb: "Connect Claude Code", icon: Bot, Component: AgentsStep },
] as const;
type StepId = (typeof STEPS)[number]["id"];
const isStep = (v: string | null): v is StepId => !!v && STEPS.some((s) => s.id === v);

export function SetupWizard() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { data, error, loading, reload } = useApi<SetupResponse>("/api/setup");
  const state = data?.state ?? null;
  const user = data?.user ?? null;
  const completed = state?.completedSteps || [];
  const firstIncomplete = STEPS.find((s) => !completed.includes(s.id))?.id || "agents";
  const urlStep = params.get("step");
  const [step, setStepState] = React.useState<StepId>(() => (isStep(urlStep) ? urlStep : "owner"));
  React.useEffect(() => { if (isStep(urlStep)) setStepState(urlStep); else if (state) setStepState(!state.ownerSet ? "owner" : firstIncomplete); }, [urlStep, state, firstIncomplete]);
  React.useEffect(() => { if (params.get("connected") === "1") toast.success("QuickBooks connected"); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const go = React.useCallback((id: StepId) => { setStepState(id); const q = new URLSearchParams(params.toString()); q.set("step", id); q.delete("connected"); router.replace(`${pathname}?${q.toString()}`, { scroll: false }); window.scrollTo({ top: 0, behavior: "smooth" }); }, [params, pathname, router]);
  const next = React.useCallback(() => { const i = STEPS.findIndex((s) => s.id === step); if (i < STEPS.length - 1) go(STEPS[i + 1].id); }, [step, go]);
  const locked = (id: StepId) => id !== "owner" && !user;
  const active = STEPS.find((s) => s.id === step) || STEPS[0];
  const Active = active.Component;

  return (
    <>
      <TopBar user={user ? { name: user.name, email: user.id } : null} />
      <main className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-6">
        <div className="mb-5">
          <h1 className="font-display text-2xl font-bold">Set up Finance Agents</h1>
          <p className="text-sm text-muted-foreground">Eight short steps. Everything can be changed later from this page; a value set in the environment wins over what you enter here.</p>
        </div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {state && !state.appSecret ? <ErrorNote><strong>APP_SECRET is missing.</strong> Set it in .env.local (<code>openssl rand -base64 32</code>) and restart — it encrypts stored tokens and signs the session cookie. Nothing can be saved until then.</ErrorNote> : null}
        <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
          <nav aria-label="Setup steps" className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:px-0">
            {STEPS.map((s, i) => {
              const done = completed.includes(s.id);
              const current = s.id === step;
              const isLocked = locked(s.id);
              return (
                <button key={s.id} type="button" disabled={isLocked} onClick={() => go(s.id)} aria-current={current ? "step" : undefined}
                  className={cn("flex shrink-0 items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors lg:w-full", current ? "border-primary bg-primary/5" : "border-border/60 hover:bg-muted/40", isLocked && "cursor-not-allowed opacity-60")}>
                  <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold", done ? "bg-emerald-500/15 text-emerald-600" : current ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{done ? <Check className="h-3.5 w-3.5" /> : isLocked ? <Lock className="h-3 w-3" /> : i + 1}</span>
                  <span className="min-w-0"><span className="block text-sm font-medium">{s.label}</span><span className="hidden truncate text-[11px] text-muted-foreground lg:block">{s.blurb}</span></span>
                </button>
              );
            })}
          </nav>
          <Card className="p-5 sm:p-6">
            {!data && loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {data && state ? (
              locked(step) ? <p className="text-sm text-muted-foreground">Sign in as the owner to continue with this step.</p> : (
                <EnvProvider value={state.envOverrides}>
                  <Active key={step} state={state} connections={data.connections ?? (null as unknown as StepProps["connections"])} user={user} reload={reload} next={next} />
                </EnvProvider>
              )
            ) : null}
          </Card>
        </div>
      </main>
    </>
  );
}
