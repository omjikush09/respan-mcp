// lib/production/summaries.ts
//
// One-call totals over a time window: how many requests, traces or threads,
// what they cost, their tokens, latency and error counts. Agents should start
// here for "how many" and "how much" questions instead of paging through rows.
//
// Contracts come from the backend catalog; each handler mirrors the backend
// executor of the same name (admin/mcp_server/log_tools.py, trace_tools.py and
// thread_tools.py in respan-backend).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthenticatedClient } from "../shared/client.js";
import { rawFetch } from "../shared/client.js";
import { pickArgs, registerBackendTool } from "../shared/backend-tool.js";
import { READ_ONLY_WORKSPACE_TOOL } from "../shared/tool-result.js";

const TIME_WINDOW_KEYS = ["start_time", "end_time", "environment"] as const;
const ORG_SCOPE_FIELD = "unique_organization_id";
/** Marks a nested either/or group inside `filters`. */
const FILTER_PARAMS_KEY = "filter_params";
const ORGANIZATION_KEY_FIELD = "organization_key_id";

/** UI display names models often use for log fields (the backend's _FIELD_ALIASES). */
const LOG_FIELD_ALIASES: Record<string, string> = {
  generation: "latency",
  "latency(generation)": "latency",
  generation_latency: "latency",
  speed: "tokens_per_second",
  ttft: "time_to_first_token",
};

type Filters = Record<string, any>;

/**
 * Maps aliases and drops the org-scope field at every depth, so a caller can
 * never widen a summary to other organizations through `filters`.
 */
function normalizedLogFilters(filters: Filters): Filters {
  const normalized: Filters = {};
  for (const [field, params] of Object.entries(filters ?? {})) {
    if (params && typeof params === "object" && FILTER_PARAMS_KEY in params) {
      const nested = params[FILTER_PARAMS_KEY];
      normalized[field] = {
        ...params,
        ...(nested && typeof nested === "object" ? { [FILTER_PARAMS_KEY]: normalizedLogFilters(nested) } : {}),
      };
      continue;
    }
    if (field === ORG_SCOPE_FIELD) continue;
    normalized[LOG_FIELD_ALIASES[field.toLowerCase()] ?? field] = params;
  }
  return normalized;
}

function withoutOrgScope(filters: Filters | undefined): Filters {
  const kept: Filters = {};
  for (const [field, params] of Object.entries(filters ?? {})) {
    if (field !== ORG_SCOPE_FIELD) kept[field] = params;
  }
  return kept;
}

/** start_time, end_time and environment as query parameters, when set. */
function timeWindowQuery(args: Record<string, any>): Record<string, string | undefined> {
  const picked = pickArgs(args, TIME_WINDOW_KEYS);
  return Object.fromEntries(Object.entries(picked).map(([key, value]) => [key, String(value)]));
}

function addFilter(filters: Filters, field: string, value: unknown, operator = ""): void {
  if (value === undefined || value === null) return;
  filters[field] = { operator, value };
}

export function registerSummaryTools(server: McpServer, client: AuthenticatedClient | null) {
  registerBackendTool(server, client, "log_summary", READ_ONLY_WORKSPACE_TOOL, async (c, args) => {
    const filters = normalizedLogFilters(args.filters ?? {});
    addFilter(filters, "model", args.model, "icontains");
    addFilter(filters, "status", args.status);
    addFilter(filters, "customer_identifier", args.customer_identifier);
    addFilter(filters, "used_custom_credential", args.used_custom_credential);

    // Match the dashboard's "Requests" metric, which only counts logs that came
    // in through an API key. An empty operator and value is the documented
    // opt-out that counts every log.
    const keyOverride = filters[ORGANIZATION_KEY_FIELD];
    if (keyOverride && typeof keyOverride === "object" && !keyOverride.operator && !keyOverride.value) {
      delete filters[ORGANIZATION_KEY_FIELD];
    } else if (!(ORGANIZATION_KEY_FIELD in filters)) {
      filters[ORGANIZATION_KEY_FIELD] = { operator: "not_empty", value: true };
    }

    const result = await rawFetch(c, "/clickhouse/request-logs/summary/", {
      query: timeWindowQuery(args),
      body: { filters },
    });
    if (args.include_scores === false && result && typeof result === "object" && "scores" in result) {
      const { scores: _omitted, ...rest } = result as Record<string, unknown>;
      return rest;
    }
    return result;
  }, "Summarize requests");

  for (const [name, path, title] of [
    ["trace_summary", "/clickhouse/traces/summary/", "Summarize traces"],
    ["thread_summary", "/clickhouse/threads/summary/", "Summarize threads"],
  ] as const) {
    registerBackendTool(server, client, name, READ_ONLY_WORKSPACE_TOOL, (c, args) => {
      const filters = withoutOrgScope(args.filters);
      return rawFetch(c, path, {
        query: timeWindowQuery(args),
        body: Object.keys(filters).length > 0 ? { filters } : {},
      });
    }, title);
  }
}
