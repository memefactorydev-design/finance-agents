// The finance-agents MCP tool set: core tools plus the finance, supplier,
// intake, orders and report tool groups.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCoreTools } from "./core-tools";
import { registerFinanceTools } from "./finance-tools";
import { registerSupplierTools } from "./supplier-tools";
import { registerIntakeTools } from "./intake-tools";
import { registerOrdersTools } from "./orders-tools";
import { registerReportTools } from "./report-tools";

type Registrar = (server: McpServer) => void;
const registrars: Registrar[] = [registerCoreTools, registerFinanceTools, registerSupplierTools, registerIntakeTools, registerOrdersTools, registerReportTools];
export async function loadRegistrars(): Promise<Registrar[]> { return registrars; }
