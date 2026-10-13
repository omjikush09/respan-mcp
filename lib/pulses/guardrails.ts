// lib/pulses/guardrails.ts
//
// Guardrails: the checks the gateway runs on request input and can block on,
// what they blocked, and which ones are on. They are not in the backend
// catalog, so the contracts are written here against respan-backend
// guardrails/views (analytics.py, behavior_guardrails.py, pii_settings.py).
//
// Read-only on purpose. Enabling a guardrail or changing PII redaction changes
// what the gateway blocks or stores live, needs an organization admin, and
// wants its own confirmation design.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { isUnauthorized, rawFetch, requireClient } from "../shared/client.js";
import { pickArgs } from "../shared/backend-tool.js";
import {
  INTERNAL_RESPONSE_KEYS,
  READ_ONLY_WORKSPACE_TOOL,
  budgetedJson,
  omitKeys,
  textResult,
} from "../shared/tool-result.js";
import { environmentShape, resolveTimeWindow } from "../production/params.js";

const ANALYTICS_PATH = "/api/guardrails/analytics/";
const BEHAVIOR_GUARDRAILS_PATH = "/api/guardrails/behaviors/";
const PII_SETTINGS_PATH = "/api/guardrails/pii/settings/";

const GRANULARITIES = ["minute", "hour", "day", "week"] as const;
const TIMESERIES_GROUP_BYS = ["outcome", "guardrail"] as const;
const GROUPED_GROUP_BYS = ["guardrail", "customer_identifier", "model", "provider_id"] as const;
/** The backend's cap on grouped rows (guardrails/utils/analytics.py MAX_GROUPS). */
const MAX_GROUPS = 100;
/** The analytics endpoints' own default window (guardrails/views/analytics.py). */
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Analytics answers are refused when over budget, never shortened: a cut group key would name the wrong customer. */
const ANALYTICS_BUDGET = { maxChars: 40_000, stringCaps: [] };
/** The catalog is at most the built-ins plus a few custom guardrails, so shortened definitions always fit. */
const LIST_BUDGET = { maxChars: 40_000, stringCaps: [2_000, 500, 200] };
/** An ISO 8601 timestamp that already names its offset (Z or ±hh:mm). */
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/** Who last changed a setting is a teammate's email, not something an answer needs. */
const EDITOR_EMAIL_KEY = "updated_by_email";

const windowShape = {
  start_time: z.string().optional().describe("Window start, ISO 8601 UTC. Default: 7 days before end_time."),
  end_time: z.string().optional().describe("Window end, ISO 8601 UTC. Default: now."),
  ...environmentShape,
};

// A 401 here has two causes the status cannot tell apart: the connection
// uses an API key (these endpoints take only a signed-in session), or the
// signed-in session expired. A 403 carries the backend's own reason (no
// active organization, no permission) and is passed through unchanged.
const SETTINGS_NEED_SESSION =
  "Respan did not accept this connection for guardrail settings. They need a signed-in session: either this MCP server is connected with an API key (connect it with OAuth instead), or the sign-in has expired and needs to be renewed. guardrail_summary, guardrail_timeseries and guardrail_grouped work with an API key too.";

/** Notes the label lookup on the tools that return guardrail ids. */
const IDS_NEED_LIST =
  "Custom guardrails appear by id; guardrail_list maps the ids of current guardrails to names (it needs a signed-in connection), and a custom guardrail deleted since has no entry there.";

/** Reads a timestamp without an offset as UTC, as the backend does, not as this machine's local time. */
function asUtc(value: string | undefined): string | undefined {
  return value && value.includes("T") && !HAS_OFFSET.test(value) ? `${value}Z` : value;
}

/** The validated window, defaulting to the backend's 7 days, plus the environment. */
function windowBody(args: { start_time?: string; end_time?: string; environment?: string }) {
  const window = resolveTimeWindow({ start_time: asUtc(args.start_time), end_time: asUtc(args.end_time) }, DEFAULT_WINDOW_MS);
  return { ...window, ...pickArgs(args, ["environment"]) };
}

/**
 * The window plus the backend's answer, inside the size budget. The budget only
 * shortens strings, and these answers are rows of numbers, so an answer still
 * over it (a fine grain over a long window) is refused rather than sent.
 */
function analyticsResult(window: Record<string, unknown>, result: unknown) {
  const body = result && typeof result === "object" && !Array.isArray(result) ? result : { result };
  const text = budgetedJson(omitKeys({ ...window, ...body }, INTERNAL_RESPONSE_KEYS), ANALYTICS_BUDGET);
  if (text.length > ANALYTICS_BUDGET.maxChars) {
    throw new Error(
      `The answer is ${text.length} characters, more than ${ANALYTICS_BUDGET.maxChars}. Ask for a coarser granularity, a shorter window, or fewer groups.`,
    );
  }
  return textResult(text);
}

export function registerGuardrailTools(server: McpServer, client: AuthenticatedClient | null) {
  server.registerTool(
    "guardrail_summary",
    {
      title: "Summarize guardrails",
      description: `Guardrail totals for a window: requests checked, passed, blocked and skipped, the block rate (blocked / checked, skipped included), and blocked requests per guardrail, largest first. One request can be blocked by more than one guardrail, so the per-guardrail counts can add up to more than total_blocked. Guardrails are checks the gateway runs on each request's input and can block on (built-in behavior guardrails and the project's custom ones).

Default window: the last 7 days. For who or what was blocked use guardrail_grouped; for a trend use guardrail_timeseries; for which guardrails are switched on use guardrail_list. ${IDS_NEED_LIST}`,
      inputSchema: windowShape,
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);
      const window = windowBody(args);
      return analyticsResult(window, await rawFetch(c, ANALYTICS_PATH, { body: window }));
    },
  );

  server.registerTool(
    "guardrail_timeseries",
    {
      title: "Guardrail counts over time",
      description: `Guardrail counts per time bucket. group_by "outcome" (default) splits every checked request into passed, blocked and skipped; "guardrail" counts blocked requests per guardrail. Default window: the last 7 days, by day. A fine grain over a long window can be too large to return; it then fails and asks for a coarser granularity or a shorter window. ${IDS_NEED_LIST}`,
      inputSchema: {
        ...windowShape,
        granularity: z.enum(GRANULARITIES).optional().describe("Bucket size. Default: day."),
        group_by: z.enum(TIMESERIES_GROUP_BYS).optional().describe("outcome (default) or guardrail."),
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);
      const window = windowBody(args);
      const result = await rawFetch(c, `${ANALYTICS_PATH}timeseries/`, {
        body: { ...window, ...pickArgs(args, ["granularity", "group_by"]) },
      });
      return analyticsResult(window, result);
    },
  );

  server.registerTool(
    "guardrail_grouped",
    {
      title: "Blocked requests by dimension",
      description: `Blocked requests broken down by one dimension: which guardrail blocked them, or which customer (customer_identifier), model or provider sent them. Largest group first. Default window: the last 7 days. ${IDS_NEED_LIST}`,
      inputSchema: {
        ...windowShape,
        group_by: z.enum(GROUPED_GROUP_BYS).describe("The dimension to group blocked requests by."),
        limit: z.number().int().min(1).max(MAX_GROUPS).optional().describe(`Most groups to return, up to ${MAX_GROUPS}.`),
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);
      const window = windowBody(args);
      const result = await rawFetch(c, `${ANALYTICS_PATH}grouped/`, {
        body: { ...window, ...pickArgs(args, ["group_by", "limit"]) },
      });
      return analyticsResult(window, result);
    },
  );

  server.registerTool(
    "guardrail_list",
    {
      title: "List guardrails",
      description: `Works only on a signed-in (OAuth) connection; on an API-key connection it returns an error saying so.

Every guardrail this project can use, built-in and custom, with what each one checks (definition) and whether it is switched on (is_enabled), when the enabled list last changed (guardrails_updated_at), plus the PII redaction settings: which categories are redacted (an empty list means the default categories), how sensitively, and whether at the gateway, in stored telemetry, or both. An enabled id the catalog no longer lists (a deleted or renamed guardrail still switched on) comes back with only its id and is_in_catalog false; every other entry has is_in_catalog true. Read-only: it never changes a guardrail.`,
      inputSchema: {},
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async () => {
      const c = requireClient(client);
      const reads = await Promise.allSettled([
        rawFetch(c, `${BEHAVIOR_GUARDRAILS_PATH}types/`, { method: "GET" }),
        rawFetch(c, `${BEHAVIOR_GUARDRAILS_PATH}settings/`, { method: "GET" }),
        rawFetch(c, PII_SETTINGS_PATH, { method: "GET" }),
      ]);
      // Decide on every failure, not whichever settled first: any 401 means the
      // session; otherwise the first read's own error, in a fixed order.
      const failures = reads.flatMap((read) => (read.status === "rejected" ? [read.reason as unknown] : []));
      if (failures.some(isUnauthorized)) throw new Error(SETTINGS_NEED_SESSION);
      if (failures.length > 0) throw failures[0];
      const [catalog, settings, pii] = reads.map((read) => (read as PromiseFulfilledResult<unknown>).value);
      if (!Array.isArray(catalog)) {
        throw new Error(`Unexpected guardrail catalog response: ${JSON.stringify(catalog)}`);
      }
      const { guardrails: enabledIds, updated_at: guardrailsUpdatedAt } = (settings ?? {}) as Record<string, unknown>;
      const enabled = new Set(Array.isArray(enabledIds) ? enabledIds.map(String) : []);
      const listed = new Set(catalog.map((entry: Record<string, unknown>) => String(entry.id)));
      const guardrails: Record<string, unknown>[] = catalog.map((entry: Record<string, unknown>) => ({
        ...entry,
        is_enabled: enabled.has(String(entry.id)),
        is_in_catalog: true,
      }));
      // An enforced id the catalog no longer lists (renamed, or deleted between
      // the two reads) still shows up, so nothing that blocks is hidden.
      for (const id of enabled) {
        if (!listed.has(id)) guardrails.push({ id, is_enabled: true, is_in_catalog: false });
      }
      return textResult(budgetedJson({
        guardrails,
        guardrails_updated_at: guardrailsUpdatedAt ?? null,
        pii_redaction: omitKeys(pii ?? {}, new Set([EDITOR_EMAIL_KEY])),
      }, LIST_BUDGET));
    },
  );
}
