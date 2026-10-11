// lib/production/index.ts
//
// Production section: what is happening in the app right now. Every tool here
// only reads the caller's workspace.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthenticatedClient } from "../shared/client.js";
import { registerFilterSchemaTools } from "./filter-schema.js";
import { registerLogGroupTools } from "./groups.js";
import { registerLogTools } from "./logs.js";
import { registerMetricTools } from "./metrics.js";
import { registerSummaryTools } from "./summaries.js";
import { registerThreadTools } from "./threads.js";
import { registerTraceTools } from "./traces.js";

export function registerProductionTools(server: McpServer, client: AuthenticatedClient | null) {
  registerLogTools(server, client);
  registerFilterSchemaTools(server, client);
  registerLogGroupTools(server, client);
  registerTraceTools(server, client);
  registerThreadTools(server, client);
  registerMetricTools(server, client);
  registerSummaryTools(server, client);
}
