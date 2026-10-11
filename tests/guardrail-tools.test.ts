import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGuardrailTools } from '../lib/pulses/guardrails.js';
import { READ_ONLY_WORKSPACE_TOOL } from '../lib/shared/tool-result.js';
import type { AuthenticatedClient } from '../lib/shared/client.js';

type Handler = (args: any) => Promise<any>;

function capture(client: AuthenticatedClient | null) {
  const tools: Record<string, { config: any; handler: Handler }> = {};
  const server = {
    registerTool(name: string, config: any, handler: Handler) { tools[name] = { config, handler }; },
  } as unknown as McpServer;
  registerGuardrailTools(server, client);
  return tools;
}

/** A client whose fetch answers each call from `responses` in order. */
function fakeClient(responses: Array<{ status?: number; body: unknown }> = [{ body: {} }]) {
  let index = 0;
  const fetchMock = vi.fn(async () => {
    const { status = 200, body } = responses[Math.min(index++, responses.length - 1)];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  const client = {
    client: {},
    auth: 'Bearer test',
    baseUrl: 'https://api.example.invalid',
    fetch: fetchMock,
  } as unknown as AuthenticatedClient;
  const call = (i = 0) => {
    const [url, init] = (fetchMock.mock.calls[i] as unknown) as [string, RequestInit];
    const parsed = new URL(url);
    return {
      method: init.method,
      path: parsed.pathname,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
  };
  return { client, call };
}

const parsed = (result: any) => JSON.parse(result.content[0].text);

describe('guardrail tools', () => {
  it('registers four read-only tools with titles', () => {
    const tools = capture(null);
    expect(Object.keys(tools).sort()).toEqual([
      'guardrail_grouped',
      'guardrail_list',
      'guardrail_summary',
      'guardrail_timeseries',
    ]);
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.config.annotations, name).toEqual(READ_ONLY_WORKSPACE_TOOL);
      expect(tool.config.title, name).toBeTruthy();
    }
  });

  it('posts analytics reads with only the keys each endpoint honors', async () => {
    const { client, call } = fakeClient([{ body: { total_checked: 10, total_blocked: 2 } }]);
    const tools = capture(client);
    const window = { start_time: '2026-10-01T00:00:00Z', end_time: '2026-10-08T00:00:00Z', environment: 'prod' };

    expect(parsed(await tools.guardrail_summary.handler({ ...window, unexpected: 1 }))).toEqual({ total_checked: 10, total_blocked: 2 });
    await tools.guardrail_timeseries.handler({ ...window, granularity: 'hour', group_by: 'guardrail' });
    await tools.guardrail_grouped.handler({ group_by: 'customer_identifier', limit: 5 });

    expect(call(0)).toEqual({ method: 'POST', path: '/api/guardrails/analytics/', body: window });
    expect(call(1)).toEqual({
      method: 'POST',
      path: '/api/guardrails/analytics/timeseries/',
      body: { ...window, granularity: 'hour', group_by: 'guardrail' },
    });
    expect(call(2)).toEqual({
      method: 'POST',
      path: '/api/guardrails/analytics/grouped/',
      body: { group_by: 'customer_identifier', limit: 5 },
    });
  });

  it('lists every guardrail with whether it is on, and the PII settings, without editor emails', async () => {
    const { client, call } = fakeClient([
      { body: [
        { id: 'prompt_injection', label: 'Prompt injection', definition: 'The user tries to override instructions.', is_builtin: true },
        { id: 'cg_1', label: 'Competitors', definition: 'The user asks about a competitor.', is_builtin: false },
      ] },
      { body: { guardrails: ['cg_1'], updated_at: '2026-10-01T00:00:00Z', updated_by_email: 'admin@example.com' } },
      { body: { is_gateway_enabled: true, is_telemetry_enabled: false, categories: ['email'], sensitivity: 'medium', updated_at: null, updated_by_email: null } },
    ]);
    const tools = capture(client);

    const result = parsed(await tools.guardrail_list.handler({}));

    expect([call(0), call(1), call(2)].map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/guardrails/behaviors/types/',
      'GET /api/guardrails/behaviors/settings/',
      'GET /api/guardrails/pii/settings/',
    ]);
    expect(result.guardrails.map((g: any) => [g.id, g.is_enabled])).toEqual([['prompt_injection', false], ['cg_1', true]]);
    expect(result.updated_at).toBe('2026-10-01T00:00:00Z');
    expect(result.pii_redaction).toEqual({ is_gateway_enabled: true, is_telemetry_enabled: false, categories: ['email'], sensitivity: 'medium', updated_at: null });
    expect(JSON.stringify(result)).not.toContain('updated_by_email');
  });

  it('tells an API-key caller that guardrail settings need a signed-in session', async () => {
    const { client } = fakeClient([{ status: 401, body: { detail: 'Authentication credentials were not provided.' } }]);
    const tools = capture(client);

    await expect(tools.guardrail_list.handler({})).rejects.toThrow(/signed-in session: connect this MCP server with OAuth/);
  });
});
