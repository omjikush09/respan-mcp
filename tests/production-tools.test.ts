import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerProductionTools } from '../lib/production/index.js';
import { resolveTimeWindow } from '../lib/production/params.js';
import { TRACE_FILTER_FIELDS } from '../lib/production/traces.js';
import { VALIDATION_ERROR_CODE } from '../lib/shared/filter-fields.js';
import { READ_ONLY_WORKSPACE_TOOL } from '../lib/shared/tool-result.js';
import { BACKEND_TOOLS } from '../lib/shared/backend-tool.js';
import type { AuthenticatedClient } from '../lib/shared/client.js';

type ToolHandler = (args: any) => Promise<any>;
interface RegisteredTool {
  config: { title?: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: unknown };
  handler: ToolHandler;
}

function captureTools(client: AuthenticatedClient | null): Record<string, RegisteredTool> {
  const tools: Record<string, RegisteredTool> = {};
  const server = {
    registerTool(name: string, config: RegisteredTool['config'], handler: ToolHandler) {
      tools[name] = { config, handler };
    },
  } as unknown as McpServer;
  registerProductionTools(server, client);
  return tools;
}

function fakeClient(body: unknown = { results: [], count: 0 }) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  const client = {
    client: {},
    auth: 'Bearer test',
    baseUrl: 'https://api.example.invalid',
    fetch: fetchMock,
  } as unknown as AuthenticatedClient;
  const call = (index = 0) => {
    const [url, init] = (fetchMock.mock.calls[index] as unknown) as [string, RequestInit];
    const parsed = new URL(url);
    return {
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      method: init.method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
  };
  return { client, fetchMock, call };
}

function parsed(result: any) {
  return JSON.parse(result.content[0].text);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('production tool surface', () => {
  const tools = captureTools(null);

  it('registers exactly the production tools', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'dashboard_llm_metrics_summary',
      'dashboard_top_models',
      'end_user_rank_by_usage',
      'log_filter_schema',
      'log_get',
      'log_groups',
      'log_list',
      'log_summary',
      'thread_get',
      'thread_list',
      'thread_summary',
      'trace_get',
      'trace_list',
      'trace_summary',
    ]);
  });

  it('marks every tool read-only with a title and a short description', () => {
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.config.annotations, name).toEqual(READ_ONLY_WORKSPACE_TOOL);
      expect(tool.config.title, name).toBeTruthy();
      // Catalog tools carry the backend's description verbatim.
      if (!BACKEND_TOOLS.has(name)) expect(tool.config.description!.length, name).toBeLessThan(1_200);
    }
  });

  it('fails clearly without credentials', async () => {
    await expect(tools.log_list.handler({})).rejects.toThrow(/requires authentication/);
  });
});

describe('resolveTimeWindow', () => {
  it('defaults to the 24 hours before now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    expect(resolveTimeWindow({})).toEqual({
      start_time: '2026-09-30T12:00:00.000Z',
      end_time: '2026-10-01T12:00:00.000Z',
    });
  });

  it('anchors the default start on a given end', () => {
    expect(resolveTimeWindow({ end_time: '2026-09-02T00:00:00Z' })).toEqual({
      start_time: '2026-09-01T00:00:00.000Z',
      end_time: '2026-09-02T00:00:00.000Z',
    });
  });

  it('rejects unparseable and inverted windows', () => {
    expect(() => resolveTimeWindow({ start_time: 'yesterday' })).toThrow(/ISO 8601/);
    expect(() => resolveTimeWindow({
      start_time: '2026-09-02T00:00:00Z',
      end_time: '2026-09-01T00:00:00Z',
    })).toThrow(/before end_time/);
  });
});

describe('log_list', () => {
  it('sends the window, paging and typed filters, and clamps page_size', async () => {
    const { client, call } = fakeClient();
    const { log_list } = captureTools(client);
    await log_list.handler({
      start_time: '2026-09-01T00:00:00Z',
      end_time: '2026-09-02T00:00:00Z',
      environment: 'prod',
      model: 'gpt-4o',
      status: 'failed',
      thread_identifier: 'chat-1',
      filters: [{ field: 'latency', operator: 'gt', value: [5] }],
      page_size: 50,
    });
    const { path, query, body } = call();
    expect(path).toBe('/api/request-logs/list/');
    expect(query).toMatchObject({
      start_time: '2026-09-01T00:00:00.000Z',
      end_time: '2026-09-02T00:00:00.000Z',
      environment: 'prod',
      sort_by: '-timestamp',
      page: '1',
      page_size: '10',
    });
    expect(query.include_fields.split(',')).toContain('unique_id');
    expect(body).toEqual({
      operator: 'AND',
      filters: {
        latency: { operator: 'gt', value: [5] },
        model: { operator: 'icontains', value: ['gpt-4o'] },
        status: { operator: '', value: ['failed'] },
        thread_identifier: { operator: '', value: ['chat-1'] },
      },
    });
  });

  it('sends an empty body without filters', async () => {
    const { client, call } = fakeClient();
    const { log_list } = captureTools(client);
    await log_list.handler({});
    expect(call().body).toEqual({});
  });

  it('returns compact rows keyed by unique_id', async () => {
    const { client } = fakeClient({
      count: 1,
      next: 'https://api.example.invalid/api/request-logs/list/?page=2',
      results: [{
        id: 'log-1',
        model: 'gpt-4o',
        cost: 0.01,
        prompt_messages: [{ role: 'user', content: 'secret prompt' }],
        storage_object_key: 'bucket/key',
      }],
    });
    const { log_list } = captureTools(client);
    const result = parsed(await log_list.handler({ page_size: 5 }));
    expect(result).toMatchObject({ page: 1, page_size: 5, has_more: true });
    // The endpoint's `count` is the page length, so no total is reported.
    expect(result).not.toHaveProperty('total');
    expect(result.results).toEqual([{ unique_id: 'log-1', model: 'gpt-4o', cost: 0.01 }]);
  });
});

describe('log_get', () => {
  it('drops internal fields and shortens huge text', async () => {
    const { client, call } = fakeClient({
      unique_id: 'log/1',
      model: 'gpt-4o',
      organization_id: 'org-1',
      keywordsai_params: { routing: {} },
      full_request: { messages: [] },
      full_response: { choices: [] },
      storage_object_key: 'bucket/key',
      prompt_messages: [{ role: 'user', content: 'x'.repeat(100_000) }],
    });
    const { log_get } = captureTools(client);
    const result = await log_get.handler({ unique_id: 'log/1' });
    expect(call()).toMatchObject({ path: '/api/request-logs/log%2F1/', method: 'GET' });
    expect(result.content[0].text.length).toBeLessThanOrEqual(40_000);
    const body = parsed(result);
    expect(body).not.toHaveProperty('full_request');
    expect(body).not.toHaveProperty('full_response');
    expect(body).not.toHaveProperty('storage_object_key');
    expect(body).not.toHaveProperty('organization_id');
    expect(body).not.toHaveProperty('keywordsai_params');
    expect(body.model).toBe('gpt-4o');
    expect(body.prompt_messages[0].content).toMatch(/…\[truncated \d+ chars\]$/);
  });
});

describe('trace_list', () => {
  it('rejects unsupported filter fields before calling the backend', async () => {
    const { client, fetchMock } = fakeClient();
    const { trace_list } = captureTools(client);

    const metadataResult = await trace_list.handler({
      filters: [{ field: 'metadata__tenant', operator: '', value: ['acme'] }],
    });
    expect(metadataResult.isError).toBe(true);
    const metadataError = parsed(metadataResult);
    expect(metadataError).toMatchObject({
      status: 'error',
      error: {
        code: VALIDATION_ERROR_CODE,
        unsupported_fields: ['metadata__tenant'],
        supported_fields: [...TRACE_FILTER_FIELDS].sort(),
      },
    });
    expect(metadataError.error.message).toMatch(/log_list/);

    const tokensResult = await trace_list.handler({
      filters: [{ field: 'total_tokens', operator: 'gt', value: [100] }],
    });
    expect(parsed(tokensResult).error.message).toMatch(/Use 'total_request_tokens'/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns the shortcuts into backend filters', async () => {
    const { client, call } = fakeClient();
    const { trace_list } = captureTools(client);
    await trace_list.handler({
      customer_identifier: 'user-7',
      name: 'checkout-agent',
      errors_only: true,
      sort_by: '-total_cost',
    });
    const { path, query, body } = call();
    expect(path).toBe('/api/traces/list/');
    expect(query).toMatchObject({ sort_by: '-total_cost', page: '1', page_size: '5' });
    expect(body).toEqual({
      filters: {
        customer_identifier: { operator: '', value: ['user-7'] },
        name: { operator: '', value: ['checkout-agent'] },
        error_count: { operator: 'gt', value: [0] },
      },
    });
  });

  it('shortens input and output previews', async () => {
    const { client } = fakeClient({
      count: 1,
      results: [{ trace_unique_id: 't1', input: 'a'.repeat(5_000), storage_object_key: 'k' }],
    });
    const { trace_list } = captureTools(client);
    const [row] = parsed(await trace_list.handler({})).results;
    expect(row).not.toHaveProperty('storage_object_key');
    expect(row.input.length).toBeLessThan(300);
  });
});

describe('trace_get', () => {
  it('drops span content when shortened text still does not fit', async () => {
    const span = (i: number) => ({
      unique_id: `span-${i}`,
      span_name: `step-${i}`,
      input: 'i'.repeat(300),
      output: 'o'.repeat(300),
      children: [],
    });
    const { client, call } = fakeClient({
      trace_unique_id: 't1',
      span_tree: Array.from({ length: 400 }, (_, i) => span(i)),
    });
    const { trace_get } = captureTools(client);
    const result = await trace_get.handler({ trace_id: 't1' });
    expect(call()).toMatchObject({ path: '/api/traces/t1/', method: 'GET' });
    expect(result.content[0].text.length).toBeLessThanOrEqual(60_000);
    const body = parsed(result);
    expect(body.span_tree[0]).toEqual({ unique_id: 'span-0', span_name: 'step-0', children: [] });
    expect(body.note).toMatch(/log_get/);
  });

  it('keeps span content for a trace that fits', async () => {
    const { client } = fakeClient({ trace_unique_id: 't1', span_tree: [{ unique_id: 's', input: 'hi' }] });
    const { trace_get } = captureTools(client);
    const body = parsed(await trace_get.handler({ trace_id: 't1' }));
    expect(body.span_tree[0].input).toBe('hi');
    expect(body).not.toHaveProperty('note');
  });
});

describe('thread tools', () => {
  it('lists threads with the min_requests shortcut', async () => {
    const { client, call } = fakeClient();
    const { thread_list } = captureTools(client);
    await thread_list.handler({ min_requests: 10, sort_by: '-total_cost' });
    const { path, query, body } = call();
    expect(path).toBe('/api/log_threads/');
    expect(query).toMatchObject({ sort_by: '-total_cost', page_size: '5' });
    expect(body).toEqual({ filters: { number_of_requests: { operator: 'gte', value: [10] } } });
  });

  it('returns compact conversation rows', async () => {
    const { client } = fakeClient({
      results: [{
        thread_identifier: 'chat-1',
        log_count: 6,
        cost: 0.002,
        organization_id: 'org-1',
        behaviors: { flagged: 'x'.repeat(3_000) },
        output: 'o'.repeat(1_000),
      }],
    });
    const { thread_list } = captureTools(client);
    const [row] = parsed(await thread_list.handler({})).results;
    expect(Object.keys(row).sort()).toEqual(['cost', 'log_count', 'output', 'thread_identifier']);
    expect(row.output.length).toBeLessThan(300);
  });

  it('reads one thread by its escaped identifier', async () => {
    const { client, call } = fakeClient({ thread_identifier: 'a/b', number_of_requests: 3 });
    const { thread_get } = captureTools(client);
    await thread_get.handler({ thread_identifier: 'a/b' });
    expect(call()).toMatchObject({ path: '/api/log_thread/a%2Fb/', method: 'GET' });
  });
});

describe('metric tools', () => {
  it('sends only the summary filters that were given, as scalars', async () => {
    const { client, call } = fakeClient({ number_of_requests: 3 });
    const { dashboard_llm_metrics_summary } = captureTools(client);
    const result = parsed(await dashboard_llm_metrics_summary.handler({ provider_id: 'anthropic' }));
    const { path, body } = call();
    expect(path).toBe('/api/dashboard/llm-metrics/summary/');
    expect(body).toEqual({ filters: { provider_id: { operator: '', value: 'anthropic' } } });
    expect(result.summary).toEqual({ number_of_requests: 3 });
  });

  it('ranks models through the breakdown endpoint and flattens its rows', async () => {
    const { client, call } = fakeClient({
      total_cost: [{ model: 'gpt-4o', total_cost: 2, date_group: null, latency_p_99: 3 }],
    });
    const { dashboard_top_models } = captureTools(client);
    const result = parsed(await dashboard_top_models.handler({ sort_by: 'total_cost', limit: 500 }));
    const { path, query, body } = call();
    expect(path).toBe('/api/dashboard/breakdown/');
    expect(query).toMatchObject({
      breakdown_by: 'model',
      include_all_metrics: 'true',
      sort_by: 'total_cost',
      limit: '50',
    });
    expect(body).toEqual({ filters: {} });
    expect(result.ranked_by).toBe('total_cost');
    expect(result.results).toEqual([{ model: 'gpt-4o', total_cost: 2 }]);
  });

  it('ranks end users by customer_identifier', async () => {
    const { client, call } = fakeClient({ number_of_requests: [] });
    const { end_user_rank_by_usage } = captureTools(client);
    await end_user_rank_by_usage.handler({ model: 'claude' });
    const { query, body } = call();
    expect(query).toMatchObject({ breakdown_by: 'customer_identifier', sort_by: 'number_of_requests', limit: '10' });
    expect(body).toEqual({ filters: { model: { operator: 'icontains', value: 'claude' } } });
  });
});

describe('log_filter_schema', () => {
  it('reads the backend filter schema with a GET and passes the environment', async () => {
    const schema = {
      filters: [{ metric: 'latency', name: 'Generation', type: 'number', operators: ['lte', '', 'gte'],
        percentiles: { p50: 1.2, p90: 4.4 }, measured_rows: 900, measured_over: "log_type = 'chat'" }],
      operators: { gte: 'greater than or equal' },
      measurements: { is_measured: true },
    };
    const { client, call } = fakeClient(schema);
    const { log_filter_schema } = captureTools(client);

    const result = parsed(await log_filter_schema.handler({ environment: 'prod' }));

    expect(call()).toMatchObject({ path: '/api/request-logs/filter-schema/', method: 'GET', query: { environment: 'prod' } });
    expect(call().body).toBeUndefined();
    expect(result).toEqual(schema);
  });

  it('sends no environment when none is asked for', async () => {
    const { client, call } = fakeClient({ filters: [], operators: {}, measurements: { is_measured: false } });
    const { log_filter_schema } = captureTools(client);

    await log_filter_schema.handler({});

    expect(call().query).toEqual({});
  });
});

describe('log_groups', () => {
  it('groups through the backend with log_list filters and keeps compact rows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T08:00:00Z'));
    const { client, call } = fakeClient({
      results: [
        { customer_identifier: 'initech_user_3', name: 'Initech', email: 'ops@initech.example', number_of_requests: 10,
          error_count: 2, error_percentage: 20, total_cost: 0.5, total_prompt_tokens: 28000, total_completion_tokens: 900,
          average_latency: 4.2, latency_p_95: null, date_group: '1970-01-01 00:00:00', max_tpm: null },
      ],
      next: null,
      count: 1,
    });
    const { log_groups } = captureTools(client);

    const result = parsed(await log_groups.handler({
      group_by: 'customer_identifier',
      filters: [{ field: 'prompt_tokens', operator: 'gte', value: [2642] }],
      sort_by: 'error_count',
      environment: 'prod',
    }));

    const { path, query, body } = call();
    expect(path).toBe('/api/request-logs/groups/');
    expect(query).toMatchObject({ group_by: 'customer_identifier', sort_by: 'error_count', environment: 'prod', page: '1', page_size: '20' });
    expect(query.start_time).toBe('2026-10-10T08:00:00.000Z');
    expect(body).toEqual({ filters: { prompt_tokens: { operator: 'gte', value: [2642] } } });
    expect(result).toMatchObject({ group_by: 'customer_identifier', returned: 1, has_more: false });
    expect(result.groups).toEqual([{
      customer_identifier: 'initech_user_3', name: 'Initech', number_of_requests: 10, error_count: 2, error_percentage: 20,
      total_cost: 0.5, total_prompt_tokens: 28000, total_completion_tokens: 900, average_latency: 4.2,
    }]);
  });

  it('reports more pages when the backend links a next page', async () => {
    const { client } = fakeClient({ results: [{ model: 'gpt-4o', number_of_requests: 5 }], next: 'https://x/?page=2' });
    const { log_groups } = captureTools(client);

    const result = parsed(await log_groups.handler({ group_by: 'model', page_size: 1 }));

    expect(result.has_more).toBe(true);
    expect(result.groups).toEqual([{ model: 'gpt-4o', number_of_requests: 5 }]);
  });

  it('never offers API key grouping, whose key is the stored key hash', () => {
    const { log_groups } = captureTools(null);
    const groupBy = (log_groups.config.inputSchema as any).group_by;
    expect(groupBy.safeParse('organization_key_id').success).toBe(false);
    expect(groupBy.safeParse('customer_identifier').success).toBe(true);
  });
});

describe('log_summary', () => {
  it('mirrors the backend executor: aliases, shortcuts, org-scope stripping and the API-key default', async () => {
    const { client, call } = fakeClient({ number_of_requests: 12, total_cost: 0.5, scores: { e1: {} } });
    const { log_summary } = captureTools(client);
    const result = parsed(await log_summary.handler({
      start_time: '2026-09-01T00:00:00Z',
      environment: 'prod',
      model: 'gpt-4o',
      status: 'failed',
      include_scores: false,
      filters: {
        ttft: { operator: 'gt', value: [1] },
        unique_organization_id: { operator: '', value: ['someone-else'] },
        either: { connector: 'OR', filter_params: { unique_organization_id: { value: ['x'] }, speed: { operator: 'lt', value: [5] } } },
      },
    }));
    const { path, query, body } = call();
    expect(path).toBe('/clickhouse/request-logs/summary/');
    expect(query).toEqual({ start_time: '2026-09-01T00:00:00Z', environment: 'prod' });
    expect(body).toEqual({
      filters: {
        time_to_first_token: { operator: 'gt', value: [1] },
        either: { connector: 'OR', filter_params: { tokens_per_second: { operator: 'lt', value: [5] } } },
        model: { operator: 'icontains', value: 'gpt-4o' },
        status: { operator: '', value: 'failed' },
        organization_key_id: { operator: 'not_empty', value: true },
      },
    });
    expect(result).toEqual({ number_of_requests: 12, total_cost: 0.5 });
  });

  it('drops the API-key default when asked to count every log', async () => {
    const { client, call } = fakeClient({ number_of_requests: 3 });
    const { log_summary } = captureTools(client);
    await log_summary.handler({ filters: { organization_key_id: { operator: '', value: '' } } });
    expect(call().body).toEqual({ filters: {} });
  });
});

describe('trace_summary and thread_summary', () => {
  it('post the window and filters without the org-scope field', async () => {
    for (const [name, path] of [
      ['trace_summary', '/clickhouse/traces/summary/'],
      ['thread_summary', '/clickhouse/threads/summary/'],
    ] as const) {
      const { client, call } = fakeClient({ summary: {} });
      const tool = captureTools(client)[name];
      await tool.handler({
        end_time: '2026-09-02T00:00:00Z',
        filters: { unique_organization_id: { value: ['x'] }, error_count: { operator: 'gt', value: [0] } },
      });
      const sent = call();
      expect(sent.path, name).toBe(path);
      expect(sent.query, name).toEqual({ end_time: '2026-09-02T00:00:00Z' });
      expect(sent.body, name).toEqual({ filters: { error_count: { operator: 'gt', value: [0] } } });
    }
  });
});
