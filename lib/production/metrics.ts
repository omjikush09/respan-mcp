// lib/production/metrics.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { rawFetch, requireClient } from "../shared/client.js";
import {
  FILTER_CONNECTORS,
  VALIDATION_ERROR_CODE,
  addFilterCondition,
  toBackendFilters,
  type BackendFilterBody,
} from "../shared/filter-fields.js";
import {
  INTERNAL_RESPONSE_KEYS,
  READ_ONLY_WORKSPACE_TOOL,
  budgetedJson,
  omitKeys,
  textResult,
} from "../shared/tool-result.js";
import {
  environmentShape,
  filterConditionSchema,
  resolveTimeWindow,
  timeWindowShape,
  type BackendFilters,
} from "./params.js";

/** Metrics the dashboard breakdown endpoint ranks by (dashboard_tools._SORT_BY_PROPERTY). */
export const RANK_METRICS = [
  "number_of_requests",
  "total_cost",
  "total_tokens",
  "error_count",
  "average_latency",
] as const;

/** Columns kept per ranked row; the endpoint returns ~30 per row. */
const RANKED_ROW_FIELDS = [
  "model",
  "provider_id",
  "prompt_id",
  "deployment_id",
  "customer_identifier",
  "name",
  "email",
  "number_of_requests",
  "total_cost",
  "average_cost",
  "total_tokens",
  "error_count",
  "error_percentage",
  "average_latency",
] as const;

const RANK_LIMIT_DEFAULT = 10;
const RANK_LIMIT_MAX = 50;

const METRICS_BUDGET = { maxChars: 20_000, stringCaps: [200] };

/** The breakdown endpoint keeps only the latest 90 days of a longer window (backend MAX_TIME_SERIES_RANGE). */
const RANK_MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** The window the endpoint actually aggregates, so the echoed range matches the numbers. */
function clampRankWindow(window: { start_time: string; end_time: string }) {
  const earliest = Date.parse(window.end_time) - RANK_MAX_WINDOW_MS;
  if (Date.parse(window.start_time) >= earliest) return window;
  return { ...window, start_time: new Date(earliest).toISOString(), requested_start_time: window.start_time };
}

/**
 * log_list filters the breakdown endpoint cannot compile: behaviors, topics
 * and fault_domain are resolved by the log list view, and messages_smart by
 * the summary view, before ClickHouse. Sent here they fail (HTTP 500) or
 * match nothing with HTTP 200. Organization scope comes from the credential.
 */
const GROUPED_UNSUPPORTED_FILTERS = [
  "behaviors",
  "topics",
  "fault_domain",
  "messages_smart",
  "organization_id",
  "unique_organization_id",
];

const groupedFilterSchema = filterConditionSchema(
  "Log field, e.g. status_code, latency, cost, customer_identifier, or 'metadata__<key>'.",
).extend({
  connector: z
    .enum(FILTER_CONNECTORS)
    .optional()
    .describe("Joins this condition to the previous one on the same field: 'AND' (default) or 'OR'."),
});

const providerIdSchema = z
  .string()
  .optional()
  .describe("Only this provider, by slug: openai, anthropic, azure, azure_openai, bedrock, google_gemini_ai, google_vertex_ai, mistral, groq, deepseek, xai, openrouter, etc.");

const rankShape = {
  sort_by: z.enum(RANK_METRICS).optional().describe("Metric to rank by (default number_of_requests)."),
  limit: z.number().int().min(1).optional().describe(`How many to return (default ${RANK_LIMIT_DEFAULT}, max ${RANK_LIMIT_MAX}).`),
};

// The dashboard views read one scalar per filter leaf, unlike the list
// endpoints, which take arrays.
function dashboardFilters(conditions: Record<string, { operator: string; value: string | undefined }>) {
  const filters: BackendFilters = {};
  for (const [field, condition] of Object.entries(conditions)) {
    if (condition.value) filters[field] = condition;
  }
  return filters;
}

/** The breakdown endpoint answers `{ "<metric>": [rows] }`; return the rows. */
function rankedRows(result: unknown): Record<string, unknown>[] {
  let rows: unknown[] = [];
  if (Array.isArray(result)) {
    rows = result;
  } else if (result && typeof result === "object") {
    rows = Object.values(result).find(Array.isArray) ?? [];
  }
  return rows.map((row) => {
    const source = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const field of RANKED_ROW_FIELDS) {
      if (field in source) projected[field] = source[field];
    }
    return projected;
  });
}

async function rankBy(
  client: AuthenticatedClient,
  breakdownBy: string,
  args: {
    start_time?: string;
    end_time?: string;
    environment?: string;
    sort_by?: (typeof RANK_METRICS)[number];
    limit?: number;
  },
  filters: BackendFilterBody,
) {
  const window = clampRankWindow(resolveTimeWindow(args));
  const sortBy = args.sort_by ?? "number_of_requests";
  const result = await rawFetch(client, "/api/dashboard/breakdown/", {
    query: {
      start_time: window.start_time,
      end_time: window.end_time,
      environment: args.environment,
      breakdown_by: breakdownBy,
      include_all_metrics: "true",
      sort_by: sortBy,
      limit: Math.min(args.limit ?? RANK_LIMIT_DEFAULT, RANK_LIMIT_MAX),
    },
    body: { filters },
  });
  return textResult(budgetedJson({
    ...window,
    ranked_by: sortBy,
    results: rankedRows(result),
  }, METRICS_BUDGET));
}

export function registerMetricTools(server: McpServer, client: AuthenticatedClient | null) {
  server.registerTool(
    "dashboard_llm_metrics_summary",
    {
      title: "Usage and health summary",
      description: `Totals for a time range: number of requests, total cost (USD), total tokens, average latency, time to first token, error count and error rate. Use it for "how is my app doing", "what did we spend this week" or "what is our error rate".

To compare periods, call it once per period with windows of equal length. Defaults to the last 24 hours.`,
      inputSchema: {
        ...timeWindowShape,
        ...environmentShape,
        model: z.string().optional().describe("Only models whose name contains this text, e.g. 'gpt-4o'."),
        provider_id: providerIdSchema,
        customer_identifier: z.string().optional().describe("Only requests from this end user of your app."),
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);
      const window = resolveTimeWindow(args);
      const result = await rawFetch(c, "/api/dashboard/llm-metrics/summary/", {
        query: { ...window, environment: args.environment },
        body: {
          filters: dashboardFilters({
            model: { operator: "icontains", value: args.model },
            provider_id: { operator: "", value: args.provider_id },
            customer_identifier: { operator: "", value: args.customer_identifier },
          }),
        },
      });
      return textResult(budgetedJson({
        ...window,
        summary: omitKeys(result, INTERNAL_RESPONSE_KEYS),
      }, METRICS_BUDGET));
    },
  );

  server.registerTool(
    "dashboard_top_models",
    {
      title: "Grouped metrics",
      description: `Compare supported groups by requests, cost, tokens, errors or latency. Select model, provider, end user, prompt or deployment as group_by. Defaults to model for compatibility.

filters narrows the requests first, e.g. status_code 429 for rate limits per model. Filtered reads use raw logs, which can have shorter retention than unfiltered totals. Defaults to the last 24 hours, ranked by number of requests; covers at most the latest 90 days.`,
      inputSchema: {
        ...timeWindowShape,
        ...environmentShape,
        provider_id: providerIdSchema,
        group_by: z.enum(["model", "provider_id", "customer_identifier", "prompt_id", "deployment_id"]).optional().describe("Grouping dimension; default model."),
        filters: z
          .array(groupedFilterSchema)
          .optional()
          .describe("Only count requests matching all of these; log_list's fields except behaviors, topics and fault_domain. Repeat a field for a range (latency gte 1, then latency lte 5); connector 'OR' on a repeat ORs it with that field's previous condition."),
        ...rankShape,
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);
      const unsupported = [...new Set((args.filters ?? []).map((f) => f.field))]
        .filter((field) => GROUPED_UNSUPPORTED_FILTERS.includes(field))
        .sort();
      if (unsupported.length > 0) {
        const error = {
          status: "error",
          error: {
            message: `metrics_grouped cannot filter by ${unsupported.join(", ")}. Use log_list for behaviors, topics or fault_domain; workspace scope comes from your credential.`,
            code: VALIDATION_ERROR_CODE,
            unsupported_fields: unsupported,
          },
        };
        return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify(error, null, 2) }] };
      }
      // provider_id adds an AND condition; it never replaces a filters condition.
      const filters: BackendFilterBody = { ...toBackendFilters(args.filters) };
      if (args.provider_id) addFilterCondition(filters, "provider_id", { operator: "", value: args.provider_id });
      return rankBy(c, args.group_by ?? "model", args, filters);
    },
  );

  server.registerTool(
    "end_user_rank_by_usage",
    {
      title: "Top end users",
      description: `Rank the end users of your app (by customer_identifier) in a time range by requests, cost, tokens, errors or latency. Use it for "who are my heaviest users" or "which users hit the most errors". These are your app's users, not members of your Respan team.

Defaults to the last 24 hours, ranked by number of requests.`,
      inputSchema: {
        ...timeWindowShape,
        ...environmentShape,
        model: z.string().optional().describe("Only models whose name contains this text, e.g. 'gpt-4o'."),
        ...rankShape,
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);
      return rankBy(c, "customer_identifier", args, dashboardFilters({
        model: { operator: "icontains", value: args.model },
      }));
    },
  );
}
