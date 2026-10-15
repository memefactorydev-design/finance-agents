import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { qboOAuth } from "@/lib/qbo/client";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();
    const q = request.nextUrl.searchParams;
    await (await qboOAuth()).callback(q.get("state") ?? "", request.cookies.get("fa_qbo_binding")?.value ?? "", user.id, q.get("realmId") ?? "", q.get("code") ?? "");
    const res = NextResponse.redirect(new URL("/setup?step=quickbooks&connected=1", request.url));
    res.cookies.set("fa_qbo_binding", "", { path: "/api/oauth/qbo", maxAge: 0 });
    return res;
  } catch (e) { return financeError(e); }
}
