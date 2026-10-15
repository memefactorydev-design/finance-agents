import { NextResponse } from "next/server";
import { requireUser } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
import { qboOAuth } from "@/lib/qbo/client";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { url, binding } = await (await qboOAuth()).begin(user.id);
    const res = NextResponse.redirect(url);
    res.cookies.set("fa_qbo_binding", binding, { path: "/api/oauth/qbo", maxAge: 600, secure: new URL(request.url).protocol === "https:", httpOnly: true, sameSite: "lax" });
    return res;
  } catch (e) { return financeError(e); }
}
