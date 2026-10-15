#!/usr/bin/env tsx
// Lists every MCP tool the server registers (and fails on duplicates).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadRegistrars } from "../lib/mcp/tools";
(async () => {
  const server = new McpServer({ name: "finance-agents", version: "0.1.0" });
  for (const r of await loadRegistrars()) r(server);
  const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
  console.log(tools.join("\n"));
  console.log(`\n${tools.length} tools`);
})().catch((e) => { console.error(e); process.exit(1); });
