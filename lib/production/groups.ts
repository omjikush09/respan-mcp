// lib/production/groups.ts
//
// Breakdowns: one row per model, provider, customer, prompt, deployment or
// custom ID, with that group's request count, errors, cost, tokens and
// latency. Answers "which customers…" and "by model" in one call instead of
// one summary per value or counting rows from log_list.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { rawFetch, requireClient } from "../shared/client.js";
import { toBackendFilters } from "../shared/filter-fields.js";
import { READ_ONLY_WORKSPACE_TOOL, budgetedJson, readListPage, textResult } from "../shared/tool-result.js";
import {
  environmentShape,
  filterConditionSchema,
  pageShape,
  resolvePage,
  resolveTimeWindow,
  timeWindowShape,
} from "./params.js";

/**
 * Dimensions /api/request-logs/groups/ groups by. API keys are left out: that
 * group key is the stored key id, which embeds the key's hash.
 */
export const LOG_GROUP_BYS = [
  "model",
  "provider_id",
  "customer_identifier",
  "prompt_id",
  "deployment_id",
  "custom_identifier",
] as const;

/** Metrics the endpoint sorts by, descending. Anything else is silently ignored there. */
const LOG_GROUP_SORTS = ["number_of_requests", "total_cost", "total_tokens", "error_count", "average_latency"] as const;

/** Per-group columns kept beside the group key. `name` labels a prompt, provider, deployment or customer. */
const LOG_GROUP_FIELDS = [
  "name",
  "number_of_requests",
  "error_count",
  "error_percentage",
  "total_cost",
  "total_prompt_tokens",
  "total_completion_tokens",
  "average_latency",
] as const;

const LOG_GROUP_PAGE_SIZE_DEFAULT = 20;
const LOG_GROUP_PAGE_SIZE_MAX = 100;
const LOG_GROUP_BUDGET = { maxChars: 40_000, stringCaps: [200, 100] };

function compactGroup(row: unknown, groupBy: string): Record<string, unknown> {
  const source = (row ?? {}) as Record<string, unknown>;
  const group: Record<string, unknown> = { [groupBy]: source[groupBy] ?? null };
  for (const field of LOG_GROUP_FIELDS) {
    if (source[field] !== undefined && source[field] !== null) group[field] = source[field];
  }
  return group;
}

export function registerLogGroupTools(server: McpServer, client: AuthenticatedClient | null) {
  server.registerTool(
    "log_groups",
    {
      title: "Break down requests",
      description: `Break requests down by one dimension: one row per model, provider, customer (customer_identifier), saved prompt, deployment or custom ID, each with its request count, error count and rate, cost, tokens and average latency. Use it for "which customers…", "by model" or "top prompts" questions; it answers in one call, so do not count log_list rows or run one summary per value.

Takes the same filters as log_list (log_filter_schema lists them), e.g. group by model with status_code 429 for rate limits per model; end_user_rank_by_usage ranks customers too but takes no filters. Requests with no value for the chosen dimension are left out. Defaults to the last 24 hours, sorted by request count. For a dimension not listed here, such as a status code or a metadata key, run log_summary once per value.`,
      inputSchema: {
        group_by: z.enum(LOG_GROUP_BYS).describe("The dimension to group requests by."),
        ...timeWindowShape,
        ...environmentShape,
        filters: z
          .array(filterConditionSchema("Log field, e.g. status_code, latency, customer_identifier, or 'metadata__<key>'. log_filter_schema lists them."))
          .optional()
          .describe("Only count requests matching all of these, as in log_list. Example: [{\"field\": \"status_code\", \"operator\": \"\", \"value\": [429]}]."),
        sort_by: z.enum(LOG_GROUP_SORTS).optional().describe("Largest first by this metric. Default: number_of_requests."),
        ...pageShape(LOG_GROUP_PAGE_SIZE_DEFAULT, LOG_GROUP_PAGE_SIZE_MAX),
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);
      const window = resolveTimeWindow(args);
      const { page, pageSize } = resolvePage(args, LOG_GROUP_PAGE_SIZE_DEFAULT, LOG_GROUP_PAGE_SIZE_MAX);
      const filters = toBackendFilters(args.filters);
      const result = await rawFetch(c, "/api/request-logs/groups/", {
        query: {
          ...window,
          group_by: args.group_by,
          environment: args.environment,
          sort_by: args.sort_by ?? "number_of_requests",
          page,
          page_size: pageSize,
        },
        body: filters ? { filters } : {},
      });
      const { rows, hasMore } = readListPage(result, pageSize);
      return textResult(budgetedJson({
        ...window,
        group_by: args.group_by,
        page,
        page_size: pageSize,
        has_more: hasMore,
        returned: rows.length,
        groups: rows.map((row) => compactGroup(row, args.group_by)),
      }, LOG_GROUP_BUDGET));
    },
  );
}
