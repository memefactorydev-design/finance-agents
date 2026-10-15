import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { verifyApiKey, type Principal } from "@/lib/core/auth";

// MCP callers authenticate with an API key minted in Setup ▸ API keys
// (Authorization: Bearer fa_… or x-api-key). Revoke the key to cut an agent off.
export const SCOPES = { read: "finance:read", write: "finance:write", admin: "finance:admin" } as const;
export async function verifyAgentToken(req: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  const key = (bearerToken || req.headers.get("x-api-key") || "").trim();
  const p = await verifyApiKey(key);
  if (!p) return undefined;
  return { token: key, clientId: p.id, scopes: [SCOPES.read, SCOPES.write, ...(p.role === "admin" ? [SCOPES.admin] : [])], extra: p as unknown as Record<string, unknown> };
}
export function principalFrom(authInfo: AuthInfo | undefined): Principal {
  const p = authInfo?.extra as Principal | undefined;
  if (!p?.id) throw new Error("Unauthenticated MCP call");
  return p;
}
export const actorName = (p: Principal) => `${p.name} (agent)`;
export type Extra = { authInfo?: AuthInfo };
export const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
export const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });
export const runTool = async <T>(fn: () => Promise<T>) => {
  try { return await fn(); }
  catch (e) {
    const { ZodError } = await import("zod");
    const msg = e instanceof ZodError ? e.errors.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") : e instanceof Error ? e.message : String(e);
    return fail(`Error: ${msg}`);
  }
};
