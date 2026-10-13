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
import { VALIDATION_ERROR_CODE, toBackendFilters } from "../shared/filter-fields.js";
import { READ_ONLY_WORKSPACE_TOOL, budgetedJson, readListPage, textResult } from "../shared/tool-result.js";
import { RANK_METRICS } from "./metrics.js";
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

/**
 * log_list filters the log list view resolves itself before querying. The
 * groups endpoint sends filters straight to ClickHouse, where these are not
 * columns, so they are rejected here.
 */
const LOG_GROUP_UNSUPPORTED_FILTERS = ["behaviors", "topics", "fault_domain"];

/** Per-group columns kept beside the group key. `name` labels a prompt, deployment or customer; dropped when it only repeats the key. */
const LOG_GROUP_FIELDS = [
  "name",
  "number_of_requests",
  "error_count",
  "error_percentage",
  "total_cost",
  "total_prompt_tokens",
  "total_completion_tokens",
  "total_tokens",
  "average_latency",
] as const;

const LOG_GROUP_PAGE_SIZE_DEFAULT = 20;
const LOG_GROUP_PAGE_SIZE_MAX = 100;
const LOG_GROUP_BUDGET = { maxChars: 40_000, stringCaps: [200, 100] };
/** The endpoint keeps only the most recent 90 days of a longer window (backend MAX_TIME_SERIES_RANGE). */
const LOG_GROUP_MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** The window the endpoint will actually aggregate, so the echoed range matches the counts. */
function clampWindow(window: { start_time: string; end_time: string }) {
  const earliest = new Date(Date.parse(window.end_time) - LOG_GROUP_MAX_WINDOW_MS);
  if (Date.parse(window.start_time) >= earliest.getTime()) return window;
  return { ...window, start_time: earliest.toISOString(), requested_start_time: window.start_time };
}

function compactGroup(row: unknown, groupBy: string): Record<string, unknown> {
  const source = (row ?? {}) as Record<string, unknown>;
  const group: Record<string, unknown> = { [groupBy]: source[groupBy] ?? null };
  for (const field of LOG_GROUP_FIELDS) {
    if (source[field] !== undefined && source[field] !== null) group[field] = source[field];
  }
  if (group.name === group[groupBy]) delete group.name;
  return group;
}

export function registerLogGroupTools(server: McpServer, client: AuthenticatedClient | null) {
  server.registerTool(
    "log_groups",
    {
      title: "Break down requests",
      description: `Break requests down by one dimension: one row per model, provider, customer (customer_identifier), saved prompt, deployment or custom ID, each with its request count, error count and rate, cost, tokens and average latency. Use it for "which customers…", "by model" or "top prompts" questions; it answers in one call, so do not count log_list rows or run one summary per value.

Takes log_list's filters except behaviors, topics and fault_domain (log_filter_schema lists them), e.g. group by model with status_code 429 for rate limits per model; dashboard_top_models and end_user_rank_by_usage rank too but filter only by provider or model. Requests with no value for the chosen dimension are left out; requests logged without an API key are counted, so totals can exceed log_summary's. Defaults to the last 24 hours, sorted by request count; covers at most the latest 90 days of a longer window. For a dimension not listed here, such as a status code or a metadata key, run log_summary once per value.`,
      inputSchema: {
        group_by: z.enum(LOG_GROUP_BYS).describe("The dimension to group requests by."),
        ...timeWindowShape,
        ...environmentShape,
        filters: z
          .array(filterConditionSchema("Log field, e.g. status_code, latency, customer_identifier, or 'metadata__<key>'. log_filter_schema lists them."))
          .optional()
          .describe("Only count requests matching all of these, as in log_list. Example: [{\"field\": \"status_code\", \"operator\": \"\", \"value\": [429]}]."),
        sort_by: z.enum(RANK_METRICS).optional().describe("Largest first by this metric. Default: number_of_requests."),
        ...pageShape(LOG_GROUP_PAGE_SIZE_DEFAULT, LOG_GROUP_PAGE_SIZE_MAX),
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);
      const unsupported = [...new Set((args.filters ?? []).map((f) => f.field))]
        .filter((field) => LOG_GROUP_UNSUPPORTED_FILTERS.includes(field));
      if (unsupported.length > 0) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "error",
              error: {
                message: `log_groups cannot filter by ${unsupported.join(", ")}. Use log_list for those, or log_summary for a total.`,
                code: VALIDATION_ERROR_CODE,
                unsupported_fields: unsupported,
              },
            }),
          }],
        };
      }
      const window = clampWindow(resolveTimeWindow(args));
      const { page, pageSize } = resolvePage(args, LOG_GROUP_PAGE_SIZE_DEFAULT, LOG_GROUP_PAGE_SIZE_MAX);
      const filters = toBackendFilters(args.filters);
      const result = await rawFetch(c, "/api/request-logs/groups/", {
        query: {
          start_time: window.start_time,
          end_time: window.end_time,
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
