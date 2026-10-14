// lib/shared/filter-fields.ts
//
// Client-side guard for the `filters` parameter of list tools.
//
// Every ClickHouse-backed list endpoint in the backend routes each root-level
// filter key to the query stage that owns its column (`columns_to_apply_filters`
// in clickhouse/utils/ch_aggregations.py::_compile_entry_list). A key that
// matches no stage is DROPPED, not rejected: the request returns HTTP 200 with
// the predicate missing, so the caller gets a wider result set and no signal
// that anything was ignored.
//
// This module closes that gap before the request is sent. A tool declares the
// closed set of fields its endpoint actually compiles (derived from the
// backend query builder; see the constants in each tool module) and rejects
// anything outside it with a typed `validation_error` result naming the
// offending keys and the supported set, so an agent can self-correct.
//
// The error shape matches the request-log guard in lib/observe/log-filters.ts
// so agents see one contract across list tools.

export interface FilterFieldSpec {
  /** Tool name, used in the error message. */
  tool: string;
  /** Exact field names the backend compiles for this tool. */
  fields: readonly string[];
  /**
   * Prefixes for dynamic Map-column keys (e.g. `metadata__` on the logs list,
   * whose backend spec has `allow_map_fields=True`). A key that starts with
   * one of these, followed by a non-empty tail, is accepted without a
   * closed-set check. Leave undefined for endpoints built with
   * `allow_map_fields=False` (traces, threads, customers).
   */
  dynamicPrefixes?: readonly string[];
  /**
   * Optional extra guidance appended to the error message, given the
   * unsupported keys (e.g. "metadata is not filterable here, use log_list").
   */
  hint?: (unsupported: readonly string[]) => string | undefined;
}

export const VALIDATION_ERROR_CODE = "validation_error";

export interface FilterGuardError {
  status: "error";
  error: {
    message: string;
    code: typeof VALIDATION_ERROR_CODE;
    unsupported_fields: string[];
    supported_fields: string[];
  };
}

export function isSupportedFilterField(field: string, spec: FilterFieldSpec): boolean {
  if (spec.fields.includes(field)) return true;
  return (spec.dynamicPrefixes ?? []).some(
    (prefix) => field.startsWith(prefix) && field.length > prefix.length,
  );
}

/** Unsupported keys among `fields`, de-duplicated and sorted. */
export function unsupportedFilterFields(fields: Iterable<string>, spec: FilterFieldSpec): string[] {
  const unsupported = new Set<string>();
  for (const field of fields) {
    if (!isSupportedFilterField(field, spec)) unsupported.add(field);
  }
  return [...unsupported].sort();
}

/**
 * Typed rejection for unsupported filter keys, or null when all are valid.
 *
 * Names the offending keys and the supported set. Sending the request instead
 * would return a wider result with HTTP 200 and no error.
 */
export function filterGuardError(fields: Iterable<string>, spec: FilterFieldSpec): FilterGuardError | null {
  const unsupported = unsupportedFilterFields(fields, spec);
  if (unsupported.length === 0) return null;

  const supported = [...spec.fields].sort();
  const parts = [
    `${spec.tool} has no filter dimension for: ${unsupported.join(", ")}. `
      + "The backend would silently ignore those keys and return a wider, unfiltered "
      + "result set, so the call is rejected instead.",
  ];
  const hint = spec.hint?.(unsupported);
  if (hint) parts.push(hint);
  let supportedLine = `Supported filter fields: ${supported.join(", ")}.`;
  if (spec.dynamicPrefixes && spec.dynamicPrefixes.length > 0) {
    supportedLine += ` Also ${spec.dynamicPrefixes.map((p) => `${p}<key>`).join(", ")}.`;
  }
  parts.push(supportedLine);
  return {
    status: "error",
    error: {
      message: parts.join(" "),
      code: VALIDATION_ERROR_CODE,
      unsupported_fields: unsupported,
      supported_fields: supported,
    },
  };
}

/** Render a guard error as an MCP tool result flagged with isError. */
export function guardErrorResult(error: FilterGuardError) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(error, null, 2) }],
  };
}

/** How a condition joins the previous condition on the same field. */
export const FILTER_CONNECTORS = ["AND", "OR"] as const;
export type FilterConnector = (typeof FILTER_CONNECTORS)[number];
const CONNECTOR_OR: FilterConnector = "OR";

/** One backend filter leaf: `{ operator, value }`, plus `connector` inside a list. */
export interface BackendCondition {
  operator: string;
  value: unknown;
  connector?: FilterConnector;
}

/**
 * The backend body shape: per field, one condition object or a list of them
 * (each list item AND-ed with the previous one unless its connector says OR),
 * or a filter bundle `{ connector, filter_params }`.
 */
export type BackendFilterBody = Record<string, BackendCondition | BackendCondition[] | BackendFilterBundle>;

export interface BackendFilterBundle {
  connector: FilterConnector;
  filter_params: Record<string, BackendCondition[]>;
}

/**
 * Key prefix for a field whose conditions contain an OR. The backend joins an
 * OR list item to the previous root condition, whatever its field, and SQL
 * binds AND tighter than OR, so `latency > 9 AND cost > 1 OR cost < 0.01`
 * would match every cheap log at any latency. Sending the field's conditions
 * as their own bundle parenthesizes them and AND-s the group with the rest. A
 * bundle's key is not a field, so the field's own key stays free for
 * convenience params.
 */
export const OR_GROUP_KEY_PREFIX = "or_group__";

type FilterInput = { field: string; operator?: string; value: unknown[]; connector?: FilterConnector };

/**
 * Adds an AND condition on `field`, keeping any condition already there: one
 * condition stays a single object, a second turns the field into a list.
 */
export function addFilterCondition(filters: BackendFilterBody, field: string, condition: BackendCondition): void {
  const existing = filters[field];
  if (existing === undefined) {
    filters[field] = condition;
  } else if (Array.isArray(existing)) {
    existing.push(condition);
  } else {
    filters[field] = [existing as BackendCondition, condition];
  }
}

/**
 * Fields, sorted, where a condition after the field's first has connector OR
 * (on the first condition a connector has nothing to join, so it is ignored).
 */
export function orConnectorFields(filters: ReadonlyArray<FilterInput> | undefined): string[] {
  const seen = new Set<string>();
  const ored = new Set<string>();
  for (const f of filters ?? []) {
    if (seen.has(f.field) && f.connector === CONNECTOR_OR) ored.add(f.field);
    seen.add(f.field);
  }
  return [...ored].sort();
}

/**
 * Converts the tool-facing `filters` array into the backend body shape.
 * Run `filterGuardError` first.
 *
 * One condition on a field stays `{ field: { operator, value } }`. Several
 * become a list in input order, AND-ed. A field with an OR connector (ignored
 * on its first condition) is sent as a bundle under `or_group__<field>`.
 */
export function toBackendFilters(filters: ReadonlyArray<FilterInput> | undefined): BackendFilterBody | undefined {
  if (!filters || filters.length === 0) return undefined;
  const byField = new Map<string, FilterInput[]>();
  for (const f of filters) {
    const group = byField.get(f.field);
    if (group) group.push(f);
    else byField.set(f.field, [f]);
  }

  const oredFields = new Set(orConnectorFields(filters));
  const body: BackendFilterBody = {};
  for (const [field, conditions] of byField) {
    if (!oredFields.has(field)) {
      for (const f of conditions) addFilterCondition(body, field, { operator: f.operator || "", value: f.value });
      continue;
    }
    body[OR_GROUP_KEY_PREFIX + field] = {
      connector: "AND",
      filter_params: {
        [field]: conditions.map((f, index) => ({
          operator: f.operator || "",
          value: f.value,
          ...(index > 0 && f.connector ? { connector: f.connector } : {}),
        })),
      },
    };
  }
  return body;
}
