import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/core/auth";
import { getConnections } from "@/lib/core/config";
import { FinanceError, equalSecret } from "@/lib/core/domain";
import { financeError } from "@/lib/core/server";
import { storeCrmTokens } from "@/lib/crm/connectors";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    await requireUser();
    const cfg = await getConnections();
    const o = cfg.crm.oauth2;
    const state = request.nextUrl.searchParams.get("state") || "", cookie = request.cookies.get("fa_crm_state")?.value || "";
    if (!state || !cookie || !equalSecret(state, cookie)) throw new FinanceError("OAUTH_STATE_INVALID", false, 400);
    const code = request.nextUrl.searchParams.get("code") || "";
    const r = await fetch(o.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: `${(process.env.APP_URL || request.nextUrl.origin).replace(/\/$/, "")}/api/oauth/crm/callback` }).toString() });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) throw new FinanceError(`CRM_OAUTH_${r.status}`, false, 502);
    await storeCrmTokens(t);
    const res = NextResponse.redirect(new URL("/setup?step=crm&connected=1", request.url));
    res.cookies.set("fa_crm_state", "", { path: "/api/oauth/crm", maxAge: 0 });
    return res;
  } catch (e) { return financeError(e); }
}
