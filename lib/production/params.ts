// lib/production/params.ts
//
// Inputs shared by the production tools: the time window, environment,
// paging, and the advanced filter condition.

import { z } from "zod";
import { FILTER_CONNECTORS } from "../shared/filter-fields.js";

/** EnvironmentChoices in the backend (utils/constants/environment_constants.py). */
export const ENVIRONMENTS = ["prod", "stage", "test"] as const;

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const timeWindowShape = {
  start_time: z
    .string()
    .optional()
    .describe("Start of the time range, ISO 8601 (e.g. 2026-09-30T00:00:00Z). Default: 24 hours before end_time."),
  end_time: z.string().optional().describe("End of the time range, ISO 8601. Default: now."),
};

export const environmentShape = {
  environment: z
    .enum(ENVIRONMENTS)
    .optional()
    .describe("Only include this environment. Default: all environments."),
};

export function pageShape(defaultSize: number, maxSize: number) {
  return {
    page: z.number().int().min(1).optional().describe("Page number, starting at 1 (default 1)."),
    page_size: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`Rows per page (default ${defaultSize}, max ${maxSize}).`),
  };
}

/** Tells the caller when its page_size was capped, instead of capping silently. */
export function pageSizeNote(requested: number | undefined, maxSize: number) {
  return requested !== undefined && requested > maxSize ? { page_size_capped_from: requested } : {};
}

export function resolvePage(
  args: { page?: number; page_size?: number },
  defaultSize: number,
  maxSize: number,
) {
  return {
    page: args.page ?? 1,
    pageSize: Math.min(args.page_size ?? defaultSize, maxSize),
  };
}

function parseTime(value: string, name: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be an ISO 8601 timestamp, got "${value}".`);
  }
  return parsed;
}

/** Fills in the default window (24 hours unless given) and normalizes both ends to ISO 8601. */
export function resolveTimeWindow(
  args: { start_time?: string; end_time?: string },
  defaultWindowMs: number = DEFAULT_WINDOW_MS,
) {
  const end = args.end_time ? parseTime(args.end_time, "end_time") : new Date();
  const start = args.start_time
    ? parseTime(args.start_time, "start_time")
    : new Date(end.getTime() - defaultWindowMs);
  if (start >= end) throw new Error("start_time must be before end_time.");
  return { start_time: start.toISOString(), end_time: end.toISOString() };
}

/** Operators the backend ClickHouse filter compiler accepts (no `iexact`). */
export const FILTER_OPERATORS = [
  "",
  "not",
  "in",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
  "icontains",
  "startswith",
  "not_startswith",
  "endswith",
  "isnull",
  "empty",
  "not_empty",
] as const;

export function filterConditionSchema(fieldDescription: string) {
  return z.object({
    field: z.string().describe(fieldDescription),
    operator: z
      .enum(FILTER_OPERATORS)
      .describe("'' = equals, 'not' = not equal, 'in' = any of the values, 'lt'/'lte'/'gt'/'gte' = comparisons, 'contains'/'icontains' = substring (icontains ignores case), 'startswith'/'not_startswith'/'endswith' = prefix or suffix, 'isnull' = null check (value [true] or [false]), 'empty'/'not_empty' = has no value / has a value (send value [true])."),
    value: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .describe("Value(s) as an array, e.g. [5], ['gpt-4o'], [true]."),
    connector: z
      .enum(FILTER_CONNECTORS)
      .optional()
      .describe("Joins this condition to the previous one on the same field: 'AND' (default) or 'OR'."),
  });
}

export type BackendFilters = Record<string, { operator: string; value: unknown }>;
