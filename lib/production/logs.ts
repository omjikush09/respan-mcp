// lib/production/logs.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { rawFetch, requireClient } from "../shared/client.js";
import { toBackendFilters } from "../shared/filter-fields.js";
import {
  INTERNAL_RESPONSE_KEYS,
  READ_ONLY_WORKSPACE_TOOL,
  budgetedJson,
  budgetedPage,
  omitKeys,
  readListPage,
  textResult,
  type PageBudget,
} from "../shared/tool-result.js";
import {
  environmentShape,
  filterConditionSchema,
  pageShape,
  pageSizeNote,
  resolvePage,
  resolveTimeWindow,
  timeWindowShape,
  type BackendFilters,
} from "./params.js";

const LOG_PAGE_SIZE_DEFAULT = 25;
const LOG_PAGE_SIZE_MAX = 100;

/** Columns log_list returns per row. Message text is left to log_get. */
export const LOG_LIST_FIELDS = [
  "unique_id",
  "timestamp",
  "model",
  "status",
  "status_code",
  "cost",
  "latency",
  "prompt_tokens",
  "completion_tokens",
  "customer_identifier",
  "prompt_name",
  "span_name",
  "trace_unique_id",
  "thread_identifier",
  "error_message",
] as const;

/**
 * Extra columns a caller can ask log_list for through `fields`: the ones the
 * list endpoint returns to both API keys and OAuth (JWT) sessions.
 */
export const LOG_OPTIONAL_FIELDS = [
  "environment",
  "provider_id",
  "log_type",
  "metadata",
  "prompt_id",
  "total_request_tokens",
  "tokens_per_second",
] as const;

export const LOG_SORT_OPTIONS = [
  "-timestamp",
  "timestamp",
  "-cost",
  "-latency",
  "-time_to_first_token",
  "-total_request_tokens",
] as const;

export const LOG_STATUSES = ["success", "failed"] as const;

/**
 * Strings are cut to 300 chars (error_message is the long one), then shrink
 * before rows are reduced to ids. Ids and filterable names stay whole so
 * log_get, trace_get and the filters can take them back. 40k chars of id- and
 * digit-heavy JSON is roughly 13-16k tokens.
 */
const LOG_LIST_BUDGET: PageBudget = {
  maxChars: 40_000,
  previewChars: 300,
  stringCaps: [120, 60],
  keepWhole: ["unique_id", "trace_unique_id", "thread_identifier", "customer_identifier", "prompt_name", "model", "span_name"],
  smallerRowsHint: "Asking without `fields` (metadata is the large one) or with a smaller page_size fits more full rows.",
};
const LOG_LIST_DETAIL_HINT = "Long text was shortened. Call log_get with a row's unique_id for the full request.";
const LOG_DETAIL_BUDGET = { maxChars: 40_000, stringCaps: [4_000, 1_500, 500] };

function projectLogRow(row: unknown, fields: readonly string[]): Record<string, unknown> {
  const source = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in source) projected[field] = source[field];
  }
  // The list endpoint names the log id `id`; log_get takes it as unique_id.
  if (projected.unique_id === undefined && source.id !== undefined) {
    projected.unique_id = source.id;
  }
  return projected;
}

export function registerLogTools(server: McpServer, client: AuthenticatedClient | null) {
  server.registerTool(
    "log_list",
    {
      title: "Find requests",
      description: `Find individual LLM requests and spans in production, newest first. Use it to answer "show me the failed requests today", "slowest gpt-4o calls this week" or "what did user X send".

Returns one page of compact rows (default ${LOG_PAGE_SIZE_DEFAULT}, up to ${LOG_PAGE_SIZE_MAX}): ${LOG_LIST_FIELDS.join(", ")}. Add columns with \`fields\`. Message text is not included: call log_get with a row's unique_id to read the full input and output.

Each page says how many rows it returned, whether anything was shortened or dropped (\`truncated\`), and \`next_page\` when there are more. When paging, send back the start_time and end_time the page reports. Defaults to the last 24 hours. The result has no total count: for totals over a period (request count, cost, error rate) use dashboard_llm_metrics_summary instead of paging through rows.`,
      inputSchema: {
        ...timeWindowShape,
        ...environmentShape,
        model: z.string().optional().describe("Only models whose name contains this text, e.g. 'gpt-4o'."),
        status: z.enum(LOG_STATUSES).optional().describe("Only successful or only failed requests."),
        customer_identifier: z.string().optional().describe("Only requests from this end user of your app."),
        thread_identifier: z.string().optional().describe("Only requests with this application conversation identifier."),
        prompt_name: z.string().optional().describe("Only requests made with this saved prompt."),
        filters: z
          .array(filterConditionSchema(
            "Log field, e.g. latency, cost, prompt_tokens, provider_id, span_name, error_message. Custom metadata uses 'metadata__<key>'.",
          ))
          .optional()
          .describe("Advanced: extra conditions on any log field, all of which must match. Example: [{\"field\": \"latency\", \"operator\": \"gt\", \"value\": [5]}]."),
        sort_by: z.enum(LOG_SORT_OPTIONS).optional().describe("Sort order (default -timestamp, newest first). '-' means descending."),
        fields: z
          .array(z.enum(LOG_OPTIONAL_FIELDS))
          .optional()
          .describe("Extra columns to include per row. Message text is not available here; log_get has it."),
        ...pageShape(LOG_PAGE_SIZE_DEFAULT, LOG_PAGE_SIZE_MAX),
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);
      const window = resolveTimeWindow(args);
      const { page, pageSize } = resolvePage(args, LOG_PAGE_SIZE_DEFAULT, LOG_PAGE_SIZE_MAX);
      const fields = [...LOG_LIST_FIELDS, ...(args.fields ?? [])];

      const filters: BackendFilters = { ...toBackendFilters(args.filters) };
      if (args.model) filters.model = { operator: "icontains", value: [args.model] };
      if (args.status) filters.status = { operator: "", value: [args.status] };
      if (args.customer_identifier) {
        filters.customer_identifier = { operator: "", value: [args.customer_identifier] };
      }
      if (args.thread_identifier) {
        filters.thread_identifier = { operator: "", value: [args.thread_identifier] };
      }
      if (args.prompt_name) filters.prompt_name = { operator: "", value: [args.prompt_name] };

      const result = await rawFetch(c, "/api/request-logs/list/", {
        query: {
          ...window,
          environment: args.environment,
          sort_by: args.sort_by ?? "-timestamp",
          page,
          page_size: pageSize,
          include_fields: [...fields, "id"].join(","),
          fetch_filters: "false",
        },
        body: Object.keys(filters).length > 0 ? { operator: "AND", filters } : {},
      });

      const { rows, hasMore } = readListPage(result, pageSize);
      return textResult(budgetedPage(
        {
          ...window,
          page,
          page_size: pageSize,
          ...pageSizeNote(args.page_size, LOG_PAGE_SIZE_MAX),
          has_more: hasMore,
        },
        rows.map((row) => projectLogRow(row, fields)),
        LOG_LIST_BUDGET,
        LOG_LIST_DETAIL_HINT,
      ));
    },
  );

  server.registerTool(
    "log_get",
    {
      title: "Read a request",
      description: `Read one LLM request or span in full: the input messages, the output, model, cost, latency, token counts, tool calls, metadata and evaluation scores.

Get the unique_id from log_list, or from a span in trace_get. Very long message text is shortened to keep the result readable.`,
      inputSchema: {
        unique_id: z.string().describe("The request's unique_id, from log_list or trace_get."),
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async ({ unique_id }) => {
      const c = requireClient(client);
      const result = await rawFetch(c, `/api/request-logs/${encodeURIComponent(unique_id)}/`, {
        method: "GET",
      });
      return textResult(budgetedJson(omitKeys(result, INTERNAL_RESPONSE_KEYS), LOG_DETAIL_BUDGET));
    },
  );
}
