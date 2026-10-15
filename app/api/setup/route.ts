import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, owner, setOwner, SESSION_COOKIE, sessionToken } from "@/lib/core/auth";
import { getConnections, redactConnections, saveConnections, type DeepPartial, type Connections } from "@/lib/core/config";
import { FinanceError } from "@/lib/core/domain";
import { financeError, sameOrigin } from "@/lib/core/server";
import { setupState } from "@/lib/core/setup";
export const dynamic = "force-dynamic";

// GET: setup state (+ redacted connections for the owner).
export async function GET() {
  try {
    const state = await setupState();
    const user = state.appSecret ? await currentUser() : null;
    const connections = user ? redactConnections(await getConnections()) : null;
    return NextResponse.json({ state, connections, user });
  } catch (e) { return financeError(e); }
}
// POST { owner: {email,name,password} } creates the owner (only while none exists, or by the owner).
// POST { connections: {...partial}, step?: string, finish?: boolean } saves a wizard step (owner only).
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = await request.json();
    const state = await setupState();
    if (!state.appSecret) throw new FinanceError("MISSING_APP_SECRET", false, 503);
    if (body.owner) {
      const input = z.object({ email: z.string().email(), name: z.string().min(1).max(100), password: z.string().min(8).max(200) }).parse(body.owner);
      const existing = await owner();
      if (existing) { const u = await currentUser(); if (!u) throw new FinanceError("UNAUTHENTICATED", false, 401); }
      await setOwner(input);
      await saveConnections({ company: { ownerEmail: input.email.toLowerCase(), approverEmails: [input.email.toLowerCase()] }, setup: { completedSteps: Array.from(new Set([...(state.completedSteps || []), "owner"])) } }, input.email);
      const res = NextResponse.json({ ok: true });
      res.cookies.set(SESSION_COOKIE, sessionToken(input.email), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 30 * 86_400 });
      return res;
    }
    const user = await currentUser();
    if (!user) throw new FinanceError("UNAUTHENTICATED", false, 401);
    const patch = (body.connections || {}) as DeepPartial<Connections>;
    stripMasked(patch as Record<string, unknown>);
    const step = typeof body.step === "string" ? body.step : null;
    const current = await getConnections();
    const completed = Array.from(new Set([...(current.setup.completedSteps || []), ...(step ? [step] : [])]));
    const saved = await saveConnections({ ...patch, setup: { completedSteps: completed, completedAt: body.finish ? new Date().toISOString() : current.setup.completedAt } }, user.id);
    return NextResponse.json({ ok: true, connections: redactConnections(saved), state: await setupState() });
  } catch (e) { return financeError(e); }
}
// Masked secrets ("••••abcd") coming back from the form mean "unchanged".
function stripMasked(o: Record<string, unknown>) {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string" && /^••••/.test(v)) delete o[k];
    else if (v && typeof v === "object" && !Array.isArray(v)) stripMasked(v as Record<string, unknown>);
  }
}
