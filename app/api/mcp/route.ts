import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { loadRegistrars } from "@/lib/mcp/tools";
import { verifyAgentToken, SCOPES } from "@/lib/mcp/auth";

// finance-agents MCP server — Streamable HTTP at /api/mcp. Auth: an API key
// from Setup ▸ API keys as `Authorization: Bearer fa_…` (or x-api-key).
// Stateless (no sessions), so it runs anywhere Next.js does.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const handler = async (request: Request) => {
  const registrars = await loadRegistrars();
  const h = createMcpHandler((server) => { for (const r of registrars) r(server); }, { serverInfo: { name: "finance-agents", version: "0.1.0" } }, { basePath: "/api", maxDuration: 180, disableSse: true, verboseLogs: false });
  const authed = withMcpAuth(h, verifyAgentToken, { required: true, requiredScopes: [SCOPES.read], resourceUrl: `${(process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "")}/api/mcp` });
  return authed(request);
};
export { handler as GET, handler as POST, handler as DELETE };
