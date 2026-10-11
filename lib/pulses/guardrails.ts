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
import { rawFetch, requireClient } from "../shared/client.js";
import { pickArgs } from "../shared/backend-tool.js";
import { READ_ONLY_WORKSPACE_TOOL, textResult } from "../shared/tool-result.js";
import { environmentShape } from "../production/params.js";

const ANALYTICS_PATH = "/api/guardrails/analytics/";
const BEHAVIOR_GUARDRAILS_PATH = "/api/guardrails/behaviors/";
const PII_SETTINGS_PATH = "/api/guardrails/pii/settings/";

const GRANULARITIES = ["minute", "hour", "day", "week"] as const;
const TIMESERIES_GROUP_BYS = ["outcome", "guardrail"] as const;
const GROUPED_GROUP_BYS = ["guardrail", "customer_identifier", "model", "provider_id"] as const;
/** The backend's cap on grouped rows (guardrails/utils/analytics.py MAX_GROUPS). */
const MAX_GROUPS = 100;
const WINDOW_KEYS = ["start_time", "end_time", "environment"] as const;

/** Who last changed a setting is a teammate's email, not something an answer needs. */
const EDITOR_EMAIL_KEY = "updated_by_email";

const windowShape = {
  start_time: z.string().optional().describe("Window start, ISO 8601 UTC. Default: 7 days ago."),
  end_time: z.string().optional().describe("Window end, ISO 8601 UTC. Default: now."),
  ...environmentShape,
};

const SETTINGS_NEED_SESSION =
  "Respan refused to read guardrail settings. They need a signed-in session: connect this MCP server with OAuth (sign in) instead of an API key. guardrail_summary, guardrail_timeseries and guardrail_grouped work with either.";

function withoutEditor(settings: unknown): Record<string, unknown> {
  const { [EDITOR_EMAIL_KEY]: _omitted, ...rest } = (settings ?? {}) as Record<string, unknown>;
  return rest;
}

export function registerGuardrailTools(server: McpServer, client: AuthenticatedClient | null) {
  server.registerTool(
    "guardrail_summary",
    {
      title: "Summarize guardrails",
      description: `Guardrail totals for a window: requests checked, passed, blocked and skipped, the block rate (blocked / checked, skipped included), and blocked requests per guardrail, largest first. One request can be blocked by more than one guardrail, so the per-guardrail counts can add up to more than total_blocked. Guardrails are checks the gateway runs on each request's input and can block on (built-in behavior guardrails and the project's custom ones).

Default window: the last 7 days. For who or what was blocked use guardrail_grouped; for a trend use guardrail_timeseries; for which guardrails are switched on use guardrail_list.`,
      inputSchema: windowShape,
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const result = await rawFetch(requireClient(client), ANALYTICS_PATH, { body: pickArgs(args, WINDOW_KEYS) });
      return textResult(JSON.stringify(result));
    },
  );

  server.registerTool(
    "guardrail_timeseries",
    {
      title: "Guardrail counts over time",
      description: `Guardrail counts per time bucket. group_by "outcome" (default) splits every checked request into passed, blocked and skipped; "guardrail" counts blocked requests per guardrail. Default window: the last 7 days, by day.`,
      inputSchema: {
        ...windowShape,
        granularity: z.enum(GRANULARITIES).optional().describe("Bucket size. Default: day."),
        group_by: z.enum(TIMESERIES_GROUP_BYS).optional().describe("outcome (default) or guardrail."),
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const result = await rawFetch(requireClient(client), `${ANALYTICS_PATH}timeseries/`, {
        body: pickArgs(args, [...WINDOW_KEYS, "granularity", "group_by"]),
      });
      return textResult(JSON.stringify(result));
    },
  );

  server.registerTool(
    "guardrail_grouped",
    {
      title: "Blocked requests by dimension",
      description: `Blocked requests broken down by one dimension: which guardrail blocked them, or which customer (customer_identifier), model or provider sent them. Largest group first. Default window: the last 7 days.`,
      inputSchema: {
        ...windowShape,
        group_by: z.enum(GROUPED_GROUP_BYS).describe("The dimension to group blocked requests by."),
        limit: z.number().int().min(1).max(MAX_GROUPS).optional().describe(`Most groups to return, up to ${MAX_GROUPS}.`),
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const result = await rawFetch(requireClient(client), `${ANALYTICS_PATH}grouped/`, {
        body: pickArgs(args, [...WINDOW_KEYS, "group_by", "limit"]),
      });
      return textResult(JSON.stringify(result));
    },
  );

  server.registerTool(
    "guardrail_list",
    {
      title: "List guardrails",
      description: `Works only on a signed-in (OAuth) connection; on an API-key connection it returns an error saying so.

Every guardrail this project can use, built-in and custom, with what each one checks (definition) and whether it is switched on (is_enabled), plus the PII redaction settings: which categories are redacted (an empty list means the default categories), how sensitively, and whether at the gateway, in stored telemetry, or both. Read-only: it never changes a guardrail.`,
      inputSchema: {},
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async () => {
      const c = requireClient(client);
      let catalog: unknown;
      let settings: unknown;
      let pii: unknown;
      try {
        [catalog, settings, pii] = await Promise.all([
          rawFetch(c, `${BEHAVIOR_GUARDRAILS_PATH}types/`, { method: "GET" }),
          rawFetch(c, `${BEHAVIOR_GUARDRAILS_PATH}settings/`, { method: "GET" }),
          rawFetch(c, PII_SETTINGS_PATH, { method: "GET" }),
        ]);
      } catch (error) {
        if (error instanceof Error && /^40[13]\b/.test(error.message)) throw new Error(SETTINGS_NEED_SESSION);
        throw error;
      }
      const { guardrails: enabledIds, ...settingsRest } = withoutEditor(settings);
      const enabled = new Set(Array.isArray(enabledIds) ? enabledIds.map(String) : []);
      const guardrails = (Array.isArray(catalog) ? catalog : []).map((entry: Record<string, unknown>) => ({
        ...entry,
        is_enabled: enabled.has(String(entry.id)),
      }));
      return textResult(JSON.stringify({ guardrails, ...settingsRest, pii_redaction: withoutEditor(pii) }));
    },
  );
}
