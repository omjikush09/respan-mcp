// lib/shared/telemetry.ts
//
// One structured log line per tool call on the hosted servers, so we can see
// which tools agents use, which fail and how big the answers are. Lines go to
// stdout, which Vercel keeps as runtime logs; a log drain can ship them on.
//
// What is never logged: argument values, tool results, credentials. A call
// carries only the argument names, sizes, timings and status codes. A hashed
// credential prefix (session_key) ties the calls of one stateless client
// together without identifying who it is.
//
// stdio is not instrumented: there stdout is the MCP protocol stream, and the
// process runs on the customer's machine, where nobody collects these lines.

import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const TOOL_CALL_EVENT = 'mcp.tool_call';
export const SESSION_INIT_EVENT = 'mcp.session_init';
export const TOOL_ALIAS_EVENT = 'mcp.tool_alias';
const EVENT_SCHEMA_VERSION = 1;

/** Bounds every client-supplied string we echo into a log line. */
const MAX_LOGGED_STRING_CHARS = 128;
const SESSION_KEY_HEX_CHARS = 12;
const HTTP_STATUS_PREFIX = /^(\d{3})\b/;
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

export type AuthKind = 'oauth' | 'jwt' | 'api_key' | 'env' | 'none';
export type ToolCallStatus = 'ok' | 'tool_error' | 'exception' | 'unknown_tool';

export interface TelemetryContext {
  /** Which hosted server: platform, enterprise or docs. */
  realm: string;
  authKind: AuthKind;
  /** First hex chars of sha256(credential); absent without a bearer. */
  sessionKey?: string;
  userAgent?: string;
  protocolVersion?: string;
}

interface ToolCallFields {
  tool: string;
  status: ToolCallStatus;
  latency_ms?: number;
  result_chars?: number;
  arg_keys?: string[];
  http_status?: number;
  error_class?: string;
}

const COMMIT = (process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7) || undefined;

const registeredNames = new WeakMap<McpServer, Set<string>>();

function bounded(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, MAX_LOGGED_STRING_CHARS) : undefined;
}

function emit(event: string, ctx: TelemetryContext, fields: object): void {
  console.info(JSON.stringify({
    evt: event,
    v: EVENT_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    commit: COMMIT,
    realm: ctx.realm,
    auth_kind: ctx.authKind,
    session_key: ctx.sessionKey,
    user_agent: ctx.userAgent,
    protocol_version: ctx.protocolVersion,
    ...fields,
  }));
}

/** sha256 prefix of a credential, so one client's calls can be grouped. */
export function sessionKeyOf(credential: string | undefined): string | undefined {
  if (!credential) return undefined;
  return createHash('sha256').update(credential).digest('hex').slice(0, SESSION_KEY_HEX_CHARS);
}

/** How the caller authenticated, read from the bearer's shape only. */
export function authKindOf(bearer: string | undefined, hasEnvironmentKey: boolean): AuthKind {
  if (!bearer) return hasEnvironmentKey ? 'env' : 'none';
  if (bearer.startsWith('mcp_at_')) return 'oauth';
  return JWT_SHAPE.test(bearer) ? 'jwt' : 'api_key';
}

export function telemetryContext(
  realm: string,
  bearer: string | undefined,
  headers: Record<string, string | string[] | undefined>,
): TelemetryContext {
  return {
    realm,
    authKind: authKindOf(bearer, Boolean(process.env.RESPAN_API_KEY)),
    sessionKey: sessionKeyOf(bearer),
    userAgent: bounded(headers['user-agent']),
    protocolVersion: bounded(headers['mcp-protocol-version']),
  };
}

function resultChars(result: unknown): number | undefined {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return undefined;
  return content.reduce((total: number, item: { type?: string; text?: unknown }) => (
    total + (item?.type === 'text' && typeof item.text === 'string'
      ? item.text.length
      : JSON.stringify(item ?? null).length)
  ), 0);
}

/** The backend HTTP status behind a thrown error, when there is one. */
export function httpStatusOf(error: unknown): number | undefined {
  const candidate = error as { statusCode?: unknown; status?: unknown; message?: unknown };
  for (const value of [candidate?.statusCode, candidate?.status]) {
    if (typeof value === 'number') return value;
  }
  const match = typeof candidate?.message === 'string' ? HTTP_STATUS_PREFIX.exec(candidate.message) : null;
  return match ? Number(match[1]) : undefined;
}

function errorClassOf(error: unknown): string | undefined {
  return bounded((error as { name?: unknown })?.name) ?? bounded(error?.constructor?.name);
}

/**
 * The SDK calls a tool callback as cb(args, extra) when the tool declares an
 * input schema and as cb(extra) when it does not. Only the first form carries
 * arguments, and only their names are kept.
 */
function argKeysOf(callArgs: unknown[]): string[] | undefined {
  if (callArgs.length < 2) return undefined;
  const args = callArgs[0];
  return args && typeof args === 'object' ? Object.keys(args).sort() : undefined;
}

function wrapCallback(name: string, callback: Function, ctx: TelemetryContext): Function {
  return async function instrumented(this: unknown, ...callArgs: unknown[]) {
    const started = performance.now();
    const argKeys = argKeysOf(callArgs);
    const latency = () => Math.round(performance.now() - started);
    try {
      const result = await callback.apply(this, callArgs);
      emit(TOOL_CALL_EVENT, ctx, {
        tool: name,
        status: (result as { isError?: unknown })?.isError ? 'tool_error' : 'ok',
        latency_ms: latency(),
        result_chars: resultChars(result),
        arg_keys: argKeys,
      } satisfies ToolCallFields);
      return result;
    } catch (error) {
      emit(TOOL_CALL_EVENT, ctx, {
        tool: name,
        status: 'exception',
        latency_ms: latency(),
        arg_keys: argKeys,
        http_status: httpStatusOf(error),
        error_class: errorClassOf(error),
      } satisfies ToolCallFields);
      throw error;
    }
  };
}

/**
 * Wraps the callback of every tool registered on `server` from here on, via
 * both `server.tool` and `server.registerTool`. Apply it after any patch that
 * filters registrations, so only tools that really registered are recorded.
 */
export function instrumentToolCalls(server: McpServer, ctx: TelemetryContext): void {
  const names = new Set<string>();
  registeredNames.set(server, names);
  for (const method of ['tool', 'registerTool'] as const) {
    const original = (server as any)[method].bind(server);
    (server as any)[method] = function (name: string, ...rest: unknown[]) {
      const last = rest.length - 1;
      if (typeof rest[last] === 'function') {
        rest[last] = wrapCallback(name, rest[last] as Function, ctx);
      }
      const registered = original(name, ...rest);
      if (registered) names.add(name);
      return registered;
    };
  }
}

/**
 * Logs what the SDK answers without calling any tool: `initialize`, which
 * names the client, and `tools/call` for a tool this server does not have.
 * `aliasedNames` are the old names the request used before they were rewritten.
 */
export function recordRequest(
  server: McpServer,
  ctx: TelemetryContext,
  body: unknown,
  aliasedNames: string[] = [],
): void {
  const names = registeredNames.get(server);
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const { method, params } = message as {
      method?: unknown;
      params?: { name?: unknown; clientInfo?: { name?: unknown; version?: unknown }; protocolVersion?: unknown };
    };
    if (method === 'initialize') {
      emit(SESSION_INIT_EVENT, ctx, {
        client_name: bounded(params?.clientInfo?.name),
        client_version: bounded(params?.clientInfo?.version),
        requested_protocol_version: bounded(params?.protocolVersion),
      });
    } else if (method === 'tools/call' && typeof params?.name === 'string' && names && !names.has(params.name)) {
      emit(TOOL_CALL_EVENT, ctx, {
        tool: bounded(params.name) ?? '',
        status: 'unknown_tool',
      } satisfies ToolCallFields);
    }
  }
  if (aliasedNames.length > 0) {
    emit(TOOL_ALIAS_EVENT, ctx, { old_names: aliasedNames.map((name) => bounded(name) ?? '') });
  }
}
