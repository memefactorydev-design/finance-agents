// Connection tests for the wizard: each returns ok/error without throwing.
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/core/auth";
import { getConnections } from "@/lib/core/config";
import { financeError, sameOrigin } from "@/lib/core/server";
import { quickBooksStatus } from "@/lib/qbo/status";
import { intakeMailboxes, mailConfigured, mailProvider } from "@/lib/mail";
import { fetchMcpProjects, fetchRestProjects, mcpListTools } from "@/lib/crm/connectors";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    sameOrigin(request); await requireUser();
    const { what } = z.object({ what: z.enum(["quickbooks", "mail", "crm", "ai"]) }).parse(await request.json());
    const cfg = await getConnections({ fresh: true });
    if (what === "quickbooks") { const s = await quickBooksStatus(); return NextResponse.json({ ok: s.connected, detail: s }); }
    if (what === "mail") {
      if (!mailConfigured(cfg)) return NextResponse.json({ ok: false, error: "Mail provider not configured" });
      const provider = await mailProvider(cfg);
      const boxes = intakeMailboxes(cfg);
      const results = await Promise.all(boxes.map(async (mb) => ({ mailbox: mb, ...(await provider.probe(mb)) })));
      return NextResponse.json({ ok: results.length > 0 && results.every((r) => r.ok), results });
    }
    if (what === "crm") {
      if (cfg.crm.mode === "rest") { const list = await fetchRestProjects(cfg); return NextResponse.json({ ok: true, count: list.length, sample: list.slice(0, 3) }); }
      if (cfg.crm.mode === "mcp") { const tools = await mcpListTools(cfg); const list = tools.includes(cfg.crm.mcp.listTool) ? await fetchMcpProjects(cfg) : []; return NextResponse.json({ ok: tools.includes(cfg.crm.mcp.listTool), tools, count: list.length, sample: list.slice(0, 3) }); }
      if (cfg.crm.mode === "webhook") return NextResponse.json({ ok: !!cfg.crm.webhook.secret, url: `${process.env.APP_URL || "http://localhost:3000"}/api/webhooks/crm` });
      return NextResponse.json({ ok: true, note: "Manual mode: projects are kept in this app" });
    }
    if (cfg.ai.extractor === "openai") {
      if (!cfg.ai.openaiApiKey) return NextResponse.json({ ok: false, error: "OPENAI_API_KEY missing" });
      const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${cfg.ai.openaiApiKey}` } });
      return NextResponse.json({ ok: r.ok, status: r.status });
    }
    if (!cfg.ai.anthropicApiKey) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY missing" });
    const r = await fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": cfg.ai.anthropicApiKey, "anthropic-version": "2023-06-01" } });
    return NextResponse.json({ ok: r.ok, status: r.status });
  } catch (e) { return financeError(e); }
}
