// lib/pulses/index.ts
//
// Behaviors and errors: what the platform flags on production traffic.
// Contracts come from the backend catalog; each handler mirrors the backend
// executor of the same name (admin/mcp_server/behavior_tools.py and
// pulse_tools.py in respan-backend).
import { registerBehaviorSettings } from "./settings.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthenticatedClient } from "../shared/client.js";
import { rawFetch } from "../shared/client.js";
import { BACKEND_TOOLS, passedArgs, pickArgs, registerBackendTool } from "../shared/backend-tool.js";
import { READ_ONLY_WORKSPACE_TOOL } from "../shared/tool-result.js";
import { ADDITIVE_WRITE_TOOL, DESTRUCTIVE_TOOL } from "../shared/tool-policy.js";

const BEHAVIORS_PATH = "/api/pulses/behaviors/";
const CUSTOM_BEHAVIORS_PATH = `${BEHAVIORS_PATH}custom/`;
const TIME_WINDOW_KEYS = ["start_time", "end_time", "environment"] as const;
const DEFINITION_KEYS = ["name", "description", "polarity"] as const;

/** POST-for-filtering analytics reads: path and the body keys they honor. */
const BEHAVIOR_ANALYTICS: Record<string, { path: string; bodyKeys: readonly string[] }> = {
  pulse_behaviors_summary: { path: BEHAVIORS_PATH, bodyKeys: [...TIME_WINDOW_KEYS, "scope"] },
  behavior_timeseries: {
    path: `${BEHAVIORS_PATH}timeseries/`,
    bodyKeys: [...TIME_WINDOW_KEYS, "scope", "granularity", "group_by", "behaviors"],
  },
  behavior_grouped: {
    path: `${BEHAVIORS_PATH}grouped/`,
    bodyKeys: [...TIME_WINDOW_KEYS, "scope", "behavior", "group_by", "limit"],
  },
  behavior_spans_list: {
    path: `${BEHAVIORS_PATH}logs/`,
    bodyKeys: [...TIME_WINDOW_KEYS, "scope", "behavior", "page", "page_size"],
  },
};

/** Error-issue fingerprints, as pulse_error_groups_list returns them. */
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function customBehaviorPath(args: Record<string, any>): string {
  return `${CUSTOM_BEHAVIORS_PATH}${encodeURIComponent(String(args.behavior_id ?? ""))}/`;
}

/**
 * The catalog's create text tells the caller to run custom_behavior_suggest and
 * custom_behavior_analyze first. This server does not offer them: both run a
 * Respan model, and the calling agent is a model that can draft and check a
 * definition itself. So the rules the analysis judged are stated here instead
 * (respan-backend pulses/utils/behaviors/suggestions.py, validity and polarity
 * criteria), on create and on update, since either one sets the definition.
 * Neither call runs a model when it is made; the scorer judges the saved
 * definition on later spans.
 */
const CUSTOM_BEHAVIOR_DEFINITION_RULES = `A usable definition names one thing a reader could spot in a single conversation, e.g. "agent promises a refund" or "user asks for a human". Terse wording is fine. Not usable: a topic ("billing"), a metric ("slow responses"), an instruction to the agent ("always be polite"), or anything that needs more than one conversation to judge.

polarity: positive = a success or a sign things went well; negative = a failure, a risk, frustration or harm; neutral = neither.`;

const CUSTOM_BEHAVIOR_CREATE_DESCRIPTION = `Create a custom behavior: something the user or the agent does in a conversation, which Respan then flags on production spans. Draft the definition and a short name yourself, check behavior_list (the behaviors that are on, built-in and custom) and every page of custom_behavior_list at page_size 50 (disabled ones included) first so it does not duplicate one, and confirm the wording with the user before creating. Always pass polarity; left out, it is stored as neutral.

${CUSTOM_BEHAVIOR_DEFINITION_RULES}`;

// A missing catalog entry throws here at load, as registerBackendTool would.
const CUSTOM_BEHAVIOR_UPDATE_DESCRIPTION = `${BACKEND_TOOLS.get("custom_behavior_update")!.description} Pass only the fields that change; the rest keep their stored values. Confirm a new wording with the user first.

${CUSTOM_BEHAVIOR_DEFINITION_RULES}`;

export function registerPulseTools(server: McpServer, client: AuthenticatedClient | null) {
  registerBehaviorSettings(server, client);
  // --- Behaviors ---
  for (const [name, route] of Object.entries(BEHAVIOR_ANALYTICS)) {
    const source = BACKEND_TOOLS.get(name)!;
    registerBackendTool(server, client, name, READ_ONLY_WORKSPACE_TOOL, (c, args) =>
      rawFetch(c, route.path, { body: pickArgs({ ...args, scope: args.scope ?? "traces" }, route.bodyKeys) }),
      { ...source, description: source.description.replace(/the default scope=spans/g, "scope=spans") + " This product tool defaults to scope=traces; specify scope=spans for gateway requests.",
        inputSchema: { ...source.inputSchema, properties: { ...source.inputSchema.properties, scope: { ...source.inputSchema.properties?.scope, description: "Count whole traces (default) or individual spans." } } },
      },
    );
  }

  registerBackendTool(server, client, "behavior_list", READ_ONLY_WORKSPACE_TOOL, (c) =>
    rawFetch(c, "/api/request-logs/behavior-columns/", { method: "GET" }),
  );

  registerBackendTool(server, client, "custom_behavior_list", READ_ONLY_WORKSPACE_TOOL, (c, args) =>
    rawFetch(c, CUSTOM_BEHAVIORS_PATH, {
      method: "GET",
      query: { page: args.page, page_size: args.page_size, tags: args.tags || undefined },
    }),
  );

  registerBackendTool(server, client, "custom_behavior_get", READ_ONLY_WORKSPACE_TOOL, (c, args) =>
    rawFetch(c, customBehaviorPath(args), { method: "GET" }),
  );

  registerBackendTool(
    server,
    client,
    "custom_behavior_create",
    ADDITIVE_WRITE_TOOL,
    (c, args) => rawFetch(c, CUSTOM_BEHAVIORS_PATH, { body: passedArgs(args, DEFINITION_KEYS) }),
    { ...BACKEND_TOOLS.get("custom_behavior_create")!, description: CUSTOM_BEHAVIOR_CREATE_DESCRIPTION },
  );

  registerBackendTool(
    server,
    client,
    "custom_behavior_update",
    DESTRUCTIVE_TOOL,
    (c, args) => rawFetch(c, customBehaviorPath(args), { method: "PATCH", body: passedArgs(args, DEFINITION_KEYS) }),
    { ...BACKEND_TOOLS.get("custom_behavior_update")!, description: CUSTOM_BEHAVIOR_UPDATE_DESCRIPTION },
  );

  registerBackendTool(server, client, "custom_behavior_delete", DESTRUCTIVE_TOOL, (c, args) =>
    rawFetch(c, customBehaviorPath(args), { method: "DELETE" }),
  );

  // --- Errors and incidents ---
  // /api/pulses/errors/ has no pagination: it returns the full top-200 ranking.
  registerBackendTool(server, client, "pulse_error_groups_list", READ_ONLY_WORKSPACE_TOOL, (c, args) =>
    rawFetch(c, "/api/pulses/errors/", {
      body: pickArgs(args, [...TIME_WINDOW_KEYS, "error_class", "provider", "status", "fault_domain"]),
    }),
  );

  registerBackendTool(server, client, "pulse_error_group_get", READ_ONLY_WORKSPACE_TOOL, async (c, args) => {
    const fingerprint = String(args.fingerprint ?? "");
    if (!FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new Error(
        `Invalid fingerprint ${JSON.stringify(fingerprint)}: pass an issue's error_fingerprint exactly as pulse_error_groups_list returned it.`,
      );
    }
    return rawFetch(c, `/api/pulses/errors/${encodeURIComponent(fingerprint)}/`, {
      body: pickArgs(args, [...TIME_WINDOW_KEYS, "limit"]),
    });
  });

  registerBackendTool(server, client, "pulse_incidents_list", READ_ONLY_WORKSPACE_TOOL, (c, args) =>
    rawFetch(c, "/api/pulses/incidents/", {
      query: { page: args.page, page_size: args.page_size },
      body: pickArgs(args, [...TIME_WINDOW_KEYS, "state", "severity", "fault_domain"]),
    }),
  );
}
