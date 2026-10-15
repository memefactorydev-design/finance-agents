"use client";

import * as React from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { MessageSquare, Send, Bot, User, Cpu } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { api, useApi, useCompany } from "@/components/use-api";
import { ErrorNote, RefreshButton, Empty } from "./section";
import { ago, fmtDate } from "./money";
import type { Brief, BriefsResponse } from "./types";

// The in-app channel the agents post their run summaries, approval requests
// and hand-offs to. The owner replies here (APPROVE <ref> / REJECT <ref>).
// Oldest at the top, newest at the bottom, like a chat.
const dayOf = (iso: string) => iso.slice(0, 10);

export function BriefsChannel() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { channelName, user } = useCompany();
  const channel = params.get("channel") || channelName;
  const { data, error, loading, reload } = useApi<BriefsResponse>(`/api/finance/briefs?channel=${encodeURIComponent(channel)}&limit=200`);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const endRef = React.useRef<HTMLDivElement>(null);
  const briefs = React.useMemo(() => [...(data?.briefs || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [data]);
  const count = briefs.length;
  React.useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [count, channel]);
  // Light polling so a reply from an agent shows up without a manual refresh.
  React.useEffect(() => { const t = window.setInterval(() => { if (document.visibilityState === "visible") reload(); }, 60_000); return () => window.clearInterval(t); }, [reload]);
  const channels = Array.from(new Set([channelName, ...(data?.channels || []), channel]));
  const setChannel = (c: string) => { const q = new URLSearchParams(params.toString()); q.set("channel", c); router.replace(`${pathname}?${q.toString()}`, { scroll: false }); };
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try { await api("/api/finance/briefs", { method: "POST", json: { text: text.trim(), channel } }); setText(""); await reload(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not post"); } finally { setBusy(false); }
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); } };
  let lastDay = "";
  return (
    <Card className="flex min-h-[60vh] flex-col p-0">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <MessageSquare className="h-4 w-4 text-primary" />
        <select className="h-8 rounded-md border border-input bg-background px-2 text-sm font-semibold" aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)}>{channels.map((c) => <option key={c} value={c}>#{c}</option>)}</select>
        <span className="text-xs text-muted-foreground">{count} message{count === 1 ? "" : "s"}</span>
        <div className="ml-auto"><RefreshButton onClick={reload} loading={loading} /></div>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {data && count === 0 ? <Empty icon={MessageSquare}>Nothing here yet. The agents post their run summaries, approval requests and hand-offs to this channel; reply below with APPROVE &lt;ref&gt; or REJECT &lt;ref&gt; when asked.</Empty> : null}
        {briefs.map((m) => {
          const day = dayOf(m.createdAt); const showDay = day !== lastDay; lastDay = day;
          return (
            <React.Fragment key={m.id}>
              {showDay ? <p className="sticky top-0 z-[1] mx-auto w-fit rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{fmtDate(day)}</p> : null}
              <Message m={m} mine={m.authorKind === "human" && !!user && (m.author === user.name || m.author === user.id)} />
            </React.Fragment>
          );
        })}
        <div ref={endRef} />
      </div>
      <div className="border-t p-3">
        <Textarea className="min-h-[64px] text-sm" placeholder={`Reply in #${channel} — e.g. APPROVE SUP-1234 · Ctrl/⌘+Enter to send`} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">Replies are read by the agents on their next run. Nothing here sends email or moves money.</p>
          <Button size="sm" className="gap-1.5" onClick={send} disabled={busy || !text.trim()}><Send className="h-3.5 w-3.5" /> {busy ? "Posting…" : "Post"}</Button>
        </div>
      </div>
    </Card>
  );
}

function Message({ m, mine }: { m: Brief; mine: boolean }) {
  const Icon = m.authorKind === "agent" ? Bot : m.authorKind === "system" ? Cpu : User;
  const [open, setOpen] = React.useState(false);
  const long = m.text.length > 700 || m.text.split("\n").length > 12;
  return (
    <div className={cn("flex gap-2", mine && "flex-row-reverse")}>
      <div className={cn("mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", m.authorKind === "agent" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}><Icon className="h-3.5 w-3.5" /></div>
      <div className={cn("min-w-0 max-w-[85%] rounded-2xl px-3 py-2 text-sm", mine ? "bg-primary text-primary-foreground" : "bg-muted/40")}>
        <p className={cn("mb-0.5 flex flex-wrap items-center gap-x-2 text-[11px]", mine ? "text-primary-foreground/80" : "text-muted-foreground")}><span className="font-medium">{m.author}</span>{m.authorKind === "agent" ? <Badge className="border-0 bg-primary/10 text-[9px] text-primary">agent</Badge> : null}<span title={m.createdAt}>{ago(m.createdAt)}</span></p>
        <pre className={cn("whitespace-pre-wrap break-words font-sans text-sm", long && !open && "line-clamp-[12]")}>{m.text}</pre>
        {long ? <button type="button" className={cn("mt-1 text-[11px] underline", mine ? "text-primary-foreground/80" : "text-primary")} onClick={() => setOpen((o) => !o)}>{open ? "Show less" : "Show all"}</button> : null}
      </div>
    </div>
  );
}
