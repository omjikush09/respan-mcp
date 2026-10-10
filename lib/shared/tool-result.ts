// lib/shared/tool-result.ts
//
// Pieces every tool handler shares: the annotation set for tools that only
// read the caller's workspace, and JSON results kept inside a size budget so
// one large log or trace cannot flood the client's context.

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Reads the caller's own Respan workspace and changes nothing. */
export const READ_ONLY_WORKSPACE_TOOL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * Backend fields that describe Respan's own bookkeeping rather than the
 * caller's data: org and key identifiers, gateway pricing internals, storage
 * pointers, and raw request/response copies of the parsed messages.
 */
export const INTERNAL_RESPONSE_KEYS: ReadonlySet<string> = new Set([
  "organization_id",
  "unique_organization_id",
  "organization_name",
  "organization_key_id",
  "organization_key_name",
  "user_email",
  "storage_object_key",
  "keywordsai_params",
  "full_request",
  "full_request_openai",
  "full_response",
  "matched_meter_ids",
  "unit_prices",
  "component_costs",
  "llm_gateway_markup_rate",
  "model_discount",
  "pricing_tier",
  "load_balance_group_id",
  "cache_key",
  "blurred",
  "io_format",
  "format_version",
  "input_words",
  "output_words",
  "input_chars",
  "output_chars",
  "system_text",
  "prompt_text",
  "completion_text",
]);

export interface JsonBudget {
  /** Upper bound on the serialized result, in characters. */
  maxChars: number;
  /** Per-string caps tried in order until the result fits. */
  stringCaps: readonly number[];
}

/** Replaces every string longer than `maxChars` with its prefix and a marker. */
export function truncateStrings(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") {
    return value.length > maxChars
      ? `${value.slice(0, maxChars)}…[truncated ${value.length - maxChars} chars]`
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => truncateStrings(item, maxChars));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, truncateStrings(item, maxChars)]),
    );
  }
  return value;
}

/** Drops `keys` at every depth of `value`. */
export function omitKeys(value: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => omitKeys(item, keys));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !keys.has(key))
        .map(([key, item]) => [key, omitKeys(item, keys)]),
    );
  }
  return value;
}

/**
 * Serializes `value`, shortening long strings step by step until the text
 * fits the budget. Returns the last attempt when no step fits, so callers that
 * need a hard bound check the length themselves.
 */
export function budgetedJson(value: unknown, budget: JsonBudget): string {
  let text = JSON.stringify(value);
  for (const cap of budget.stringCaps) {
    if (text.length <= budget.maxChars) break;
    text = JSON.stringify(truncateStrings(value, cap));
  }
  return text;
}

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Rows and a has-more flag from a backend list response. The list endpoints'
 * `count` is the length of the returned page, not a total, so it is not read.
 */
export function readListPage(result: unknown, pageSize: number) {
  const body = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const rows: unknown[] = Array.isArray(result)
    ? result
    : Array.isArray(body.results)
      ? body.results
      : Array.isArray(body.data)
        ? body.data
        : [];
  const hasMore = typeof body.next === "string" || (body.next === undefined && rows.length === pageSize);
  return { rows, hasMore };
}

export interface ListPage {
  page: number;
  page_size: number;
  has_more: boolean;
}

/**
 * Serializes one page of list rows within `budget`, and never cuts silently.
 * Long strings are shortened first, through `stringCaps`; if the rows still do
 * not fit, rows are dropped from the end. The page then says what happened:
 * `returned`, `truncated` with a hint, and `next_page` when it is safe to just
 * move on (it is withheld when rows were dropped, since the next page would
 * skip them).
 */
export function budgetedPage(
  envelope: Record<string, unknown> & ListPage,
  rows: readonly unknown[],
  budget: JsonBudget,
  detailHint: string,
): string {
  const render = (kept: readonly unknown[], cap?: number) => {
    const omittedRows = rows.length - kept.length;
    const truncated = cap === undefined && omittedRows === 0 ? undefined : {
      ...(cap !== undefined ? { strings_shortened_to: cap } : {}),
      ...(omittedRows > 0 ? { omitted_rows: omittedRows } : {}),
      hint: omittedRows > 0
        ? `Only ${kept.length} of ${rows.length} rows fit. Ask again with fewer fields, or with page_size=${kept.length} starting from page 1.`
        : detailHint,
    };
    return JSON.stringify({
      ...envelope,
      returned: kept.length,
      ...(envelope.has_more && omittedRows === 0 ? { next_page: envelope.page + 1 } : {}),
      ...(truncated ? { truncated } : {}),
      results: cap === undefined ? kept : truncateStrings(kept, cap),
    });
  };

  let cap: number | undefined;
  let text = render(rows);
  for (const stringCap of budget.stringCaps) {
    if (text.length <= budget.maxChars) return text;
    cap = stringCap;
    text = render(rows, cap);
  }
  let kept = rows.length;
  while (text.length > budget.maxChars && kept > 1) {
    kept = Math.max(1, Math.floor(kept * 0.8));
    text = render(rows.slice(0, kept), cap);
  }
  return text;
}
