// Inbound CRM push: POST a project (or {projects:[…]}) with
// X-Signature: sha256=<hex HMAC of the raw body under the shared secret>
// (or Authorization: Bearer <secret>). Deletions: {id, deleted:true}.
import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { getConnections } from "@/lib/core/config";
import { equalSecret, FinanceError } from "@/lib/core/domain";
import { financeError } from "@/lib/core/server";
import { normaliseIncomingProject } from "@/lib/crm/mapping";
import { deleteProject, upsertProject } from "@/lib/crm/projects";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const cfg = await getConnections();
    const secret = cfg.crm.webhook.secret;
    if (!secret) throw new FinanceError("CRM_WEBHOOK_NOT_CONFIGURED", false, 503);
    const raw = await request.text();
    const sigHeader = (request.headers.get("x-signature") || request.headers.get("x-hub-signature-256") || "").replace(/^sha256=/, "");
    const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    const ok = (!!sigHeader && equalSecret(sigHeader, expected)) || (!!bearer && equalSecret(bearer, secret));
    if (!ok) throw new FinanceError("WEBHOOK_SIGNATURE_INVALID", false, 401);
    const body = JSON.parse(raw);
    const items: any[] = Array.isArray(body) ? body : Array.isArray(body.projects) ? body.projects : [body];
    const results: { id: string | undefined; action: string }[] = [];
    for (const item of items) {
      if (item?.deleted && item?.id) { await deleteProject(String(item.id)); results.push({ id: String(item.id), action: "deleted" }); continue; }
      const p = normaliseIncomingProject(item, cfg.crm.rest.mapping);
      const saved = await upsertProject({ ...p, source: { kind: "webhook", externalId: p.id || null, syncedAt: new Date().toISOString() } }, "crm-webhook");
      results.push({ id: saved.id, action: "upserted" });
    }
    return NextResponse.json({ ok: true, results });
  } catch (e) { return financeError(e); }
}
