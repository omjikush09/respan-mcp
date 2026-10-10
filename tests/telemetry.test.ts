import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpHandler, createServer } from '../lib/shared/mcp-handler.js';
import {
  authKindOf,
  httpStatusOf,
  instrumentToolCalls,
  recordRequest,
  sessionKeyOf,
  type TelemetryContext,
} from '../lib/shared/telemetry.js';

const CTX: TelemetryContext = { realm: 'platform', authKind: 'api_key', sessionKey: 'abc123def456' };
const SECRET_ARG_VALUE = 'customer-secret-value-7c1e';

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function events(): any[] {
  return info.mock.calls.map(([line]: [string]) => JSON.parse(line));
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'telemetry-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function serverWithTools(): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  instrumentToolCalls(server, CTX);
  server.registerTool(
    'echo',
    { description: 'echo', inputSchema: { query: z.string(), token: z.string().optional() } },
    async ({ query }) => ({ content: [{ type: 'text', text: `you said ${query}` }] }),
  );
  server.tool('no_args', 'takes nothing', async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  server.registerTool(
    'reports_error',
    { description: 'tool-level error', inputSchema: { id: z.string() } },
    async () => ({ content: [{ type: 'text', text: 'not found' }], isError: true }),
  );
  server.registerTool(
    'throws_backend_error',
    { description: 'backend 404', inputSchema: { id: z.string() } },
    async () => { throw new Error('404 Not Found: {"detail":"Trace not found"}'); },
  );
  server.registerTool(
    'throws_sdk_error',
    { description: 'sdk 429', inputSchema: {} },
    async () => { throw Object.assign(new Error('Too many requests'), { name: 'RespanError', statusCode: 429 }); },
  );
  return server;
}

describe('tool call telemetry', () => {
  it('logs one event per successful call with argument names but not values', async () => {
    const client = await connect(serverWithTools());
    await client.callTool({ name: 'echo', arguments: { query: 'hello', token: SECRET_ARG_VALUE } });
    await client.close();

    const [event] = events();
    expect(event).toMatchObject({
      evt: 'mcp.tool_call',
      v: 1,
      tool: 'echo',
      status: 'ok',
      realm: 'platform',
      auth_kind: 'api_key',
      session_key: 'abc123def456',
      arg_keys: ['query', 'token'],
      result_chars: 'you said hello'.length,
    });
    expect(typeof event.latency_ms).toBe('number');
    expect(JSON.stringify(info.mock.calls)).not.toContain(SECRET_ARG_VALUE);
    expect(JSON.stringify(info.mock.calls)).not.toContain('hello');
  });

  it('logs no argument names for a tool without an input schema', async () => {
    const client = await connect(serverWithTools());
    await client.callTool({ name: 'no_args', arguments: {} });
    await client.close();
    expect(events()[0]).toMatchObject({ tool: 'no_args', status: 'ok' });
    expect(events()[0].arg_keys).toBeUndefined();
  });

  it('marks a result with isError as a tool error', async () => {
    const client = await connect(serverWithTools());
    await client.callTool({ name: 'reports_error', arguments: { id: 'x' } });
    await client.close();
    expect(events()[0]).toMatchObject({ tool: 'reports_error', status: 'tool_error' });
  });

  it('records the backend status and error class of a thrown error, and still fails the call', async () => {
    const client = await connect(serverWithTools());
    const backend = await client.callTool({ name: 'throws_backend_error', arguments: { id: 'x' } });
    const sdk = await client.callTool({ name: 'throws_sdk_error', arguments: {} });
    await client.close();

    expect(backend.isError).toBe(true);
    expect(sdk.isError).toBe(true);
    expect(events()).toEqual([
      expect.objectContaining({ tool: 'throws_backend_error', status: 'exception', http_status: 404, error_class: 'Error' }),
      expect.objectContaining({ tool: 'throws_sdk_error', status: 'exception', http_status: 429, error_class: 'RespanError' }),
    ]);
    // The backend body in the error message is not copied into the log line.
    expect(JSON.stringify(info.mock.calls)).not.toContain('Trace not found');
  });

  it('instruments every tool on /mcp and treats filtered-out tools as unknown', async () => {
    const server = createServer(null, new Set(['trace_list']), CTX);
    recordRequest(server, CTX, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'log_list' } });
    recordRequest(server, CTX, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trace_list' } });
    expect(events()).toEqual([expect.objectContaining({ tool: 'log_list', status: 'unknown_tool' })]);
  });

  it('logs old tool names as one alias event, not as extra calls', () => {
    const server = createServer(null, undefined, CTX);
    recordRequest(server, CTX, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'log_list' } }, ['list_logs']);
    expect(events()).toEqual([expect.objectContaining({ evt: 'mcp.tool_alias', old_names: ['list_logs'] })]);
  });

  it('leaves createServer uninstrumented without a telemetry context', async () => {
    const client = await connect(createServer(null, new Set(['docs_search_missing'])));
    await client.close();
    expect(info).not.toHaveBeenCalled();
  });
});

describe('telemetry helpers', () => {
  it('classifies credentials by shape', () => {
    expect(authKindOf('mcp_at_abc', false)).toBe('oauth');
    expect(authKindOf('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln', false)).toBe('jwt');
    expect(authKindOf('AbCdEfGh.0123456789abcdef0123456789abcdef', false)).toBe('api_key');
    expect(authKindOf(undefined, true)).toBe('env');
    expect(authKindOf(undefined, false)).toBe('none');
  });

  it('hashes credentials into a short stable key', () => {
    const key = sessionKeyOf('some-api-key');
    expect(key).toMatch(/^[0-9a-f]{12}$/);
    expect(sessionKeyOf('some-api-key')).toBe(key);
    expect(sessionKeyOf('another-key')).not.toBe(key);
    expect(sessionKeyOf(undefined)).toBeUndefined();
  });

  it('reads the HTTP status from SDK errors and from rawFetch messages', () => {
    expect(httpStatusOf({ statusCode: 403 })).toBe(403);
    expect(httpStatusOf({ status: 502 })).toBe(502);
    expect(httpStatusOf(new Error('400 Bad Request: {}'))).toBe(400);
    expect(httpStatusOf(new Error('network down'))).toBeUndefined();
  });
});

class MockResponse {
  statusCode = 200;
  headers = new Map<string, string | string[]>();
  body: any;
  headersSent = false;
  setHeader(name: string, value: string | string[]) { this.headers.set(name.toLowerCase(), value); return this; }
  getHeader(name: string) { return this.headers.get(name.toLowerCase()); }
  status(code: number) { this.statusCode = code; return this; }
  json(body: unknown) { this.body = body; this.headersSent = true; return this; }
  send(body: unknown) { this.body = body; this.headersSent = true; return this; }
}

function rpcRequest(body: unknown) {
  return {
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: 'Bearer AbCdEfGh.0123456789abcdef0123456789abcdef',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
      'user-agent': 'claude-code/2.1.0',
    },
    body,
    socket: { remoteAddress: '127.0.0.1' },
  } as any;
}

describe('hosted handler telemetry', () => {
  const handler = createMcpHandler('https://api.respan.ai', '/.well-known/oauth-protected-resource', 'platform');

  it('logs the client named in initialize', async () => {
    await handler(rpcRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } },
    }), new MockResponse() as any);

    expect(events()).toEqual([expect.objectContaining({
      evt: 'mcp.session_init',
      client_name: 'claude-code',
      client_version: '2.1.0',
      requested_protocol_version: '2025-11-25',
      realm: 'platform',
      auth_kind: 'api_key',
      user_agent: 'claude-code/2.1.0',
      protocol_version: '2025-11-25',
    })]);
    expect(events()[0].session_key).toMatch(/^[0-9a-f]{12}$/);
  });

  it('logs a call to a tool the server does not have', async () => {
    const response = new MockResponse();
    await handler(rpcRequest({
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_everything', arguments: {} },
    }), response as any);

    expect(events()).toEqual([expect.objectContaining({ evt: 'mcp.tool_call', tool: 'delete_everything', status: 'unknown_tool' })]);
  });
});
