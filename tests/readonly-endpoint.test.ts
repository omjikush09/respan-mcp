import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthBroker } from '../lib/oauth/broker.js';
import { loadOAuthConfig, resetOAuthConfigForTests } from '../lib/oauth/config.js';
import { InMemorySessionStore } from '../lib/oauth/memory-store.js';
import { resetSessionStoreForTests, setSessionStoreForTests } from '../lib/oauth/store-factory.js';
import readOnlyHandler from '../api/mcp/readonly.js';
import { createMcpHandler } from '../lib/shared/mcp-handler.js';
import readOnlyResourceMetadata from '../api/well-known/oauth-protected-resource-readonly.js';
import enterpriseReadOnlyResourceMetadata from '../api/well-known/oauth-protected-resource-enterprise-readonly.js';

const SECRET = 'readonly-test-secret-that-is-at-least-thirty-two';
const VERIFIER = 'r'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const REDIRECT = 'http://127.0.0.1/callback';
const API_KEY = 'AbCdEfGh.0123456789abcdef0123456789abcdef';

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
  end() { this.headersSent = true; return this; }
}

function jwt(marker: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 4 * 60 * 60, marker }))
    .toString('base64url');
  return `${header}.${payload}.signature`;
}

function rpc(credential: string, method: string, params: unknown, url = '/mcp/readonly') {
  return {
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${credential}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    },
    body: { jsonrpc: '2.0', id: 3, method, params },
    socket: { remoteAddress: '127.0.0.1' },
  } as any;
}

function rpcResult(response: MockResponse): any {
  if (typeof response.body === 'object' && response.body !== null && !Buffer.isBuffer(response.body)) {
    return response.body;
  }
  const text = String(response.body);
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(data ? data.slice('data: '.length) : text);
}

async function toolNames(handler: (req: any, res: any) => Promise<unknown>, credential: string, url?: string) {
  const response = new MockResponse();
  await handler(rpc(credential, 'tools/list', {}, url), response as any);
  return rpcResult(response).result.tools.map((tool: { name: string }) => tool.name);
}

beforeEach(async () => {
  process.env.OAUTH_SECRET = SECRET;
  process.env.OAUTH_SESSION_STORE = 'memory';
  process.env.MCP_PUBLIC_BASE_URL = 'https://mcp.respan.ai';
  delete process.env.MCP_LEGACY_SCOPE;
  resetOAuthConfigForTests();
  await resetSessionStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/mcp/readonly with an API key', () => {
  it('lists only read-only tools', async () => {
    setSessionStoreForTests(new InMemorySessionStore());
    const names = await toolNames(readOnlyHandler, API_KEY);
    expect(names).toContain('log_list');
    expect(names).toContain('trace_get');
    for (const write of ['prompt_deploy', 'prompt_create', 'dataset_delete', 'grader_run', 'org_switch']) {
      expect(names, write).not.toContain(write);
    }
  });

  it('refuses a write tool and points at the full URL, without a consent challenge', async () => {
    setSessionStoreForTests(new InMemorySessionStore());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = new MockResponse();
    await readOnlyHandler(rpc(API_KEY, 'tools/call', { name: 'dataset_delete', arguments: {} }), response as any);

    const { result } = rpcResult(response);
    expect(result.isError).toBe(true);
    const error = JSON.parse(result.content[0].text).error;
    expect(error.code).toBe('insufficient_scope');
    expect(error.hint).toContain('/mcp/readonly');
    expect(result._meta).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves /mcp unfiltered for the same key', async () => {
    setSessionStoreForTests(new InMemorySessionStore());
    const full = createMcpHandler('https://api.respan.ai', '/.well-known/oauth-protected-resource', 'platform');
    expect(await toolNames(full, API_KEY, '/mcp')).toContain('prompt_deploy');
  });
});

describe('/mcp/readonly with OAuth', () => {
  it('grants read scope only, binds the token to /mcp, and works on both URLs', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const config = loadOAuthConfig(process.env);
    const broker = new OAuthBroker({ config, store });
    const readOnlyResource = 'https://mcp.respan.ai/mcp/readonly';

    const started = await broker.startAuthorization({
      realm: 'platform',
      clientId: 'enc_client',
      clientName: 'Read-only URL test',
      redirectUri: REDIRECT,
      clientState: 'state',
      codeChallenge: CHALLENGE,
      resource: readOnlyResource,
    });
    expect(started.transaction.resource).toBe('https://mcp.respan.ai/mcp');
    expect(started.transaction.requestedScope).toBe('mcp:read');

    // Even a tampered "allow changes" cannot widen what the client asked for.
    await broker.approveAuthorization('platform', started.transactionToken, started.browserCsrf, undefined, true);
    const redirect = await broker.completeAuthorization({
      realm: 'platform',
      transactionToken: started.transactionToken,
      browserCsrf: started.browserCsrf,
      backendAccessJwt: jwt('access'),
      backendRefreshJwt: jwt('refresh'),
    });
    const pair = await broker.exchangeAuthorizationCode({
      code: new URL(redirect).searchParams.get('code')!,
      codeVerifier: VERIFIER,
      clientId: 'enc_client',
      redirectUri: REDIRECT,
      resource: readOnlyResource,
    });
    expect(pair.scope).toBe('mcp:read');

    const full = createMcpHandler('https://api.respan.ai', '/.well-known/oauth-protected-resource', 'platform');
    expect(await toolNames(readOnlyHandler, pair.access_token)).not.toContain('prompt_deploy');
    const onFullUrl = await toolNames(full, pair.access_token, '/mcp');
    expect(onFullUrl).toContain('log_list');
    expect(onFullUrl).not.toContain('prompt_deploy');
  });

  it('accepts the read-only resource when refreshing', async () => {
    const store = new InMemorySessionStore();
    const config = loadOAuthConfig(process.env);
    const backendRefresh = vi.fn(async () => new Response(
      JSON.stringify({ access: jwt('access-2'), refresh: jwt('refresh-2') }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const broker = new OAuthBroker({ config, store, fetch: backendRefresh });
    const started = await broker.startAuthorization({
      realm: 'platform', clientId: 'enc_client', clientName: 'Refresh test', redirectUri: REDIRECT,
      clientState: 'state', codeChallenge: CHALLENGE, resource: 'https://mcp.respan.ai/mcp/readonly',
    });
    await broker.approveAuthorization('platform', started.transactionToken, started.browserCsrf);
    const redirect = await broker.completeAuthorization({
      realm: 'platform', transactionToken: started.transactionToken, browserCsrf: started.browserCsrf,
      backendAccessJwt: jwt('access'), backendRefreshJwt: jwt('refresh'),
    });
    const pair = await broker.exchangeAuthorizationCode({
      code: new URL(redirect).searchParams.get('code')!, codeVerifier: VERIFIER, clientId: 'enc_client', redirectUri: REDIRECT,
    });
    const refreshed = await broker.refresh({
      refreshToken: pair.refresh_token, clientId: 'enc_client', resource: 'https://mcp.respan.ai/mcp/readonly',
    });
    expect(refreshed.scope).toBe('mcp:read');
  });
});

describe('/mcp/readonly discovery and routing', () => {
  it('publishes its own resource metadata with read scope only', () => {
    const platform = new MockResponse();
    readOnlyResourceMetadata({ method: 'GET' } as any, platform as any);
    expect(platform.body).toEqual({
      resource: 'https://mcp.respan.ai/mcp/readonly',
      authorization_servers: ['https://mcp.respan.ai'],
      scopes_supported: ['mcp:read'],
    });
    const enterprise = new MockResponse();
    enterpriseReadOnlyResourceMetadata({ method: 'GET' } as any, enterprise as any);
    expect(enterprise.body.resource).toBe('https://mcp.respan.ai/mcp/enterprise/readonly');
    expect(enterprise.body.authorization_servers).toEqual(['https://mcp.respan.ai/enterprise-oauth']);
  });

  it('routes the read-only URLs and their metadata on Vercel', () => {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
      rewrites: Array<{ source: string; destination: string }>;
      functions: Record<string, unknown>;
    };
    const route = (source: string) => vercel.rewrites.find((rewrite) => rewrite.source === source)?.destination;
    expect(route('/mcp/readonly')).toBe('/api/mcp/readonly');
    expect(route('/mcp/enterprise/readonly')).toBe('/api/mcp/enterprise-readonly');
    expect(route('/.well-known/oauth-protected-resource/mcp/readonly'))
      .toBe('/api/well-known/oauth-protected-resource-readonly');
    expect(route('/.well-known/oauth-protected-resource/mcp/enterprise/readonly'))
      .toBe('/api/well-known/oauth-protected-resource-enterprise-readonly');
    expect(vercel.functions['api/mcp/readonly.ts']).toBeDefined();
  });
});
