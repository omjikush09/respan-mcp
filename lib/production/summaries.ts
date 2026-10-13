// lib/production/summaries.ts
//
// One-call totals over a time window: how many requests, traces or threads,
// what they cost, their tokens and latency (trace totals also count errors).
// Agents should start here for "how many" and "how much" questions instead of
// paging through rows.
//
// Contracts come from the backend catalog; each handler mirrors the backend
// executor of the same name (admin/mcp_server/log_tools.py, trace_tools.py and
// thread_tools.py in respan-backend). log_summary calls the /api twin of the
// executor's /clickhouse/request-logs/summary/ route (same view), like log_list.
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

/** A Python dict: a non-null, non-array object (the executor's `isinstance(x, dict)`). */
function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Maps aliases and drops the org-scope field at every depth, so a caller can
 * never widen a summary to other organizations through `filters`. The result
 * has no prototype and aliases are read as own keys only, so keys such as
 * `__proto__` or `constructor` pass through as plain (unknown) fields.
 */
function normalizedFilters(filters: Filters | undefined, aliases: Record<string, string> = {}): Filters {
  const normalized: Filters = Object.create(null);
  for (const [field, params] of Object.entries(filters ?? {})) {
    if (field === ORG_SCOPE_FIELD) continue;
    if (isPlainObject(params) && FILTER_PARAMS_KEY in params) {
      const nested = params[FILTER_PARAMS_KEY];
      normalized[field] = {
        ...params,
        ...(isPlainObject(nested) ? { [FILTER_PARAMS_KEY]: normalizedFilters(nested, aliases) } : {}),
      };
      continue;
    }
    const alias = field.toLowerCase();
    normalized[Object.hasOwn(aliases, alias) ? aliases[alias] : field] = params;
  }
  return normalized;
}

/** Python truthiness, which the backend executor's `if args.get(...)` checks use. */
function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * start_time, end_time and environment as query parameters, when set. An unset
 * window is left to the backend, whose default the catalog documents.
 */
function timeWindowQuery(args: Record<string, any>): Record<string, string> {
  const picked = pickArgs(args, TIME_WINDOW_KEYS);
  return Object.fromEntries(Object.entries(picked).map(([key, value]) => [key, String(value)]));
}

function addFilter(filters: Filters, field: string, value: unknown, operator = ""): void {
  filters[field] = { operator, value };
}

export function registerSummaryTools(server: McpServer, client: AuthenticatedClient | null) {
  registerBackendTool(server, client, "log_summary", READ_ONLY_WORKSPACE_TOOL, async (c, args) => {
    const filters = normalizedFilters(args.filters, LOG_FIELD_ALIASES);
    if (isTruthy(args.model)) addFilter(filters, "model", args.model, "icontains");
    if (isTruthy(args.status)) addFilter(filters, "status", args.status);
    if (isTruthy(args.customer_identifier)) addFilter(filters, "customer_identifier", args.customer_identifier);
    if (args.used_custom_credential !== undefined && args.used_custom_credential !== null) {
      addFilter(filters, "used_custom_credential", args.used_custom_credential);
    }

    // Match the dashboard's "Requests" metric, which only counts logs that came
    // in through an API key. An empty operator and value is the documented
    // opt-out that counts every log.
    const keyOverride = filters[ORGANIZATION_KEY_FIELD];
    if (isPlainObject(keyOverride) && !isTruthy(keyOverride.operator) && !isTruthy(keyOverride.value)) {
      delete filters[ORGANIZATION_KEY_FIELD];
    } else if (!(ORGANIZATION_KEY_FIELD in filters)) {
      filters[ORGANIZATION_KEY_FIELD] = { operator: "not_empty", value: true };
    }

    const result = await rawFetch(c, "/api/request-logs/summary/", {
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
      const filters = normalizedFilters(args.filters);
      return rawFetch(c, path, {
        query: timeWindowQuery(args),
        body: Object.keys(filters).length > 0 ? { filters } : {},
      });
    }, title);
  }
}
