// lib/production/filter-schema.ts
//
// The log filters the caller's project can set, so an agent writes its own
// `filters` instead of guessing field names, values and thresholds. The backend
// serves the catalog Respan's own natural-language search reads: what each
// field means, the project's own values and its measured percentiles. Here the
// agent is the model, so no search model is called.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthenticatedClient } from "../shared/client.js";
import { rawFetch, requireClient } from "../shared/client.js";
import { READ_ONLY_WORKSPACE_TOOL, textResult } from "../shared/tool-result.js";
import { environmentShape } from "./params.js";

export function registerFilterSchemaTools(server: McpServer, client: AuthenticatedClient | null) {
  server.registerTool(
    "log_filter_schema",
    {
      title: "List log filters",
      description: `List this project's log filters for log_list and log_summary, the same set the Respan UI offers: the field, its operators, what it means, this project's own values (models, providers, customers, status codes, metadata keys) and, for numbers, measured percentiles.

Call it before filtering when unsure of a field name or value, or when the user says something vague like "slow", "expensive" or "long prompts": use a percentile as the threshold, e.g. latency gte p90. Each percentile names the rows it was measured over (measured_over, e.g. log_type = 'chat'); add that condition too, or the threshold also matches rows outside it. Numbers are in stored units: latency in seconds, cost in US dollars.

measurements.is_measured is false the first time a project is asked; values and percentiles appear on a later call.`,
      inputSchema: { ...environmentShape },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);
      const result = await rawFetch(c, "/api/request-logs/filter-schema/", {
        method: "GET",
        query: { environment: args.environment },
      });
      return textResult(JSON.stringify(result));
    },
  );
}
