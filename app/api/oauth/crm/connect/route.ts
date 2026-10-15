// Generic OAuth2 authorization-code start for a REST CRM.
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { requireUser } from "@/lib/core/auth";
import { getConnections } from "@/lib/core/config";
import { FinanceError } from "@/lib/core/domain";
import { financeError } from "@/lib/core/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await requireUser();
    const cfg = await getConnections();
    const o = cfg.crm.oauth2;
    if (!o.enabled || !o.authorizeUrl || !o.clientId) throw new FinanceError("CRM_OAUTH_NOT_CONFIGURED", false, 503);
    const state = randomBytes(16).toString("base64url");
    const u = new URL(o.authorizeUrl);
    u.searchParams.set("client_id", o.clientId);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", `${(process.env.APP_URL || new URL(request.url).origin).replace(/\/$/, "")}/api/oauth/crm/callback`);
    if (o.scopes) u.searchParams.set("scope", o.scopes);
    u.searchParams.set("state", state);
    const res = NextResponse.redirect(u.toString());
    res.cookies.set("fa_crm_state", state, { path: "/api/oauth/crm", maxAge: 600, httpOnly: true, sameSite: "lax" });
    return res;
  } catch (e) { return financeError(e); }
}
