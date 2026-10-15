import { NextResponse } from "next/server";
import { z } from "zod";
import { SESSION_COOKIE, sessionToken, verifyOwner } from "@/lib/core/auth";
import { financeError } from "@/lib/core/server";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(await request.json());
    const o = await verifyOwner(email, password);
    if (!o) return NextResponse.json({ error: { code: "INVALID_LOGIN" } }, { status: 401 });
    const res = NextResponse.json({ ok: true, user: { email: o.email, name: o.name } });
    res.cookies.set(SESSION_COOKIE, sessionToken(o.email), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 30 * 86_400 });
    return res;
  } catch (e) { return financeError(e); }
}
