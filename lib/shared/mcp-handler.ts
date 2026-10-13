import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { RespanClient } from '@respan/respan-api';
import type { AuthenticatedClient } from './client.js';
import { registerProductionTools } from '../production/index.js';
import { registerPulseTools } from '../pulses/index.js';
import { registerPromptTools } from '../develop/prompts.js';
import { registerExperimentTools } from '../develop/experiments.js';
import { registerEvaluatorTools } from '../evaluate/evaluators.js';
import { registerDatasetTools } from '../evaluate/datasets.js';
import { registerEvaluationPipelineTools } from '../evaluate/pipelines.js';
import { registerWorkflowTools } from '../develop/workflows.js';
import { registerOrganizationTools } from '../account/organizations.js';
import {
  applyToolPolicy,
  hiddenWriteToolsOf,
  registerReadOnlyToolsOnly,
} from './tool-policy.js';
import { resolveToolName, rewriteToolCallNames } from './tool-aliases.js';
import { OAuthBroker, type ResolvedAccess } from '../oauth/broker.js';
import { getOAuthConfig, type OAuthRealm } from '../oauth/config.js';
import { InvalidAccessTokenError } from '../oauth/errors.js';
import { isReadOnlySession, MCP_READ_SCOPE, MCP_WRITE_SCOPE, SUPPORTED_SCOPES } from '../oauth/scopes.js';
import { getSessionStore } from '../oauth/store-factory.js';
import { SessionStoreUnavailableError } from '../oauth/store.js';
import {
  DisallowedBackendUrlError,
  resolveAllowedBackendUrl,
} from './backend-url.js';

export function createServer(
  client: AuthenticatedClient | null,
  enabledTools?: Set<string>,
  isReadOnly = false,
): McpServer {
  const server = new McpServer({
    name: 'respan',
    version: '1.0.0',
  });
  applyToolPolicy(server);
  // Before the enabled-tools filter, so a tool the caller turned off is not
  // reported as hidden for lack of scope.
  if (isReadOnly) registerReadOnlyToolsOnly(server);

  if (enabledTools?.size) {
    const originalTool = server.tool.bind(server);
    (server as any).tool = function (name: string) {
      if (!enabledTools.has(name)) return;
      return originalTool.apply(server, arguments as any);
    };
    const originalRegisterTool = (server as any).registerTool.bind(server);
    (server as any).registerTool = function (name: string) {
      if (!enabledTools.has(name)) return;
      return originalRegisterTool.apply(server, arguments as any);
    };
  }

  registerProductionTools(server, client);
  registerPulseTools(server, client);
  registerPromptTools(server, client);
  registerExperimentTools(server, client);
  registerEvaluatorTools(server, client);
  registerDatasetTools(server, client);
  registerEvaluationPipelineTools(server, client);
  registerWorkflowTools(server, client);
  registerOrganizationTools(server, client);
  return server;
}

function bearerCredential(req: VercelRequest): string | undefined {
  const authHeader = req.headers.authorization;
  return authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
}

function canonicalPublicBaseUrl(): string {
  return (process.env.MCP_PUBLIC_BASE_URL || 'https://mcp.respan.ai').replace(/\/+$/, '');
}

function challenge(resourceMetadataPath: string, scope?: string): string {
  const scopeParam = scope ? `scope="${scope}", ` : '';
  return `Bearer ${scopeParam}resource_metadata="${canonicalPublicBaseUrl()}${resourceMetadataPath}"`;
}

/** `scope` is set on a read-only URL, so a client asks for read scope only. */
function sendUnauthorized(
  res: VercelResponse,
  resourceMetadataPath: string,
  scope?: string,
): VercelResponse {
  res.setHeader('WWW-Authenticate', challenge(resourceMetadataPath, scope));
  return res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized' },
    id: null,
  });
}

/** `message` as a tools/call request (it has an id) for a hidden write tool, if it is one. */
function hiddenWriteToolRequest(
  hidden: ReadonlySet<string>,
  message: unknown,
): { id: unknown; name: string } | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: { name?: unknown } };
  if (id === undefined || method !== 'tools/call' || typeof params?.name !== 'string' || !hidden.has(params.name)) return undefined;
  return { id, name: params.name };
}

/**
 * The tools/call requests in `body` that target hidden write tools, when every
 * message in it is one (a single request, or a batch made only of them). A
 * mixed batch or an id-less message falls through to the transport, which
 * still refuses the hidden tool (it was never registered), just without the
 * insufficient_scope explanation.
 */
function hiddenWriteToolCalls(
  server: McpServer,
  body: unknown,
): { id: unknown; name: string }[] | undefined {
  const hidden = hiddenWriteToolsOf(server);
  if (hidden.size === 0) return undefined;
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return undefined;
  const blocked = messages.map((message) => hiddenWriteToolRequest(hidden, message));
  return blocked.every((call) => call !== undefined)
    ? (blocked as { id: unknown; name: string }[])
    : undefined;
}

/**
 * A tool error, not a protocol error, so the agent reads why and what to do.
 * On a read-only consent, `_meta["mcp/www_authenticate"]` lets ChatGPT offer
 * the user a new consent; on a read-only URL no consent can help, so the hint
 * points at the full URL instead.
 */
function insufficientScopeResult(
  toolName: string,
  resourceMetadataPath: string,
  readOnlyEndpointPath?: string,
) {
  const error = {
    code: 'insufficient_scope',
    message: `${toolName} changes data, and this connection is read-only.`,
    hint: readOnlyEndpointPath
      ? `This server URL (${readOnlyEndpointPath}) only serves read-only tools. `
        + 'To change data, the user must connect to the same URL without /readonly, '
        + 'with an API key that can write or a new sign-in that ticks "Also allow changes". '
        + 'Read-only tools keep working here.'
      : 'Ask the user to reconnect Respan and tick "Also allow changes" on the '
        + 'consent page. The page offers that option only when this client requests '
        + 'write access. Read-only tools keep working without it.',
    // No scope enables writes on a read-only URL.
    ...(readOnlyEndpointPath ? {} : { required_scope: MCP_WRITE_SCOPE }),
  };
  const scope = SUPPORTED_SCOPES.join(' ');
  return {
    content: [{ type: 'text', text: JSON.stringify({ error }) }],
    isError: true,
    ...(readOnlyEndpointPath ? {} : {
      _meta: {
        'mcp/www_authenticate': [
          `Bearer error="insufficient_scope", scope="${scope}", `
            + `resource_metadata="${canonicalPublicBaseUrl()}${resourceMetadataPath}"`,
        ],
      },
    }),
  };
}

function sdkBackendBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/api\/?$/, '');
}

function toWebRequest(req: VercelRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const method = req.method || 'POST';
  return new Request(
    `${canonicalPublicBaseUrl()}${req.url || '/mcp'}`,
    {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: JSON.stringify(req.body ?? {}) }),
    },
  );
}

async function bufferWebResponse(response: Response): Promise<{
  status: number;
  headers: Headers;
  body: Buffer;
}> {
  return {
    status: response.status,
    headers: response.headers,
    body: Buffer.from(await response.arrayBuffer()),
  };
}

function sendWebResponse(
  response: {
    status: number;
    headers: Headers;
    body: Buffer;
  },
  res: VercelResponse,
): void {
  for (const [name, value] of response.headers.entries()) {
    res.setHeader(name, value);
  }
  res.status(response.status).send(response.body);
}

export type McpHandlerOptions = {
  /** A /readonly URL: read-only tools only, whatever the credential allows. */
  readOnlyEndpointPath?: string;
};

export function createMcpHandler(
  defaultBaseUrl: string,
  resourceMetadataPath: string,
  realm: OAuthRealm,
  options: McpHandlerOptions = {},
) {
  const challengeScope = options.readOnlyEndpointPath ? MCP_READ_SCOPE : undefined;
  return async function handler(req: VercelRequest, res: VercelResponse) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');

    if (req.method === 'GET') {
      return res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'SSE streams not supported in stateless mode. Use POST for tool calls.' },
        id: null,
      });
    }
    if (req.method === 'DELETE') {
      return res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session management not supported in stateless mode.' },
        id: null,
      });
    }

    let oauthAccess: ResolvedAccess | undefined;
    try {
      const bearer = bearerCredential(req);
      let backendCredential: string | undefined;
      let baseUrl: string;
      let backendUnauthorized = false;

      if (bearer?.startsWith('mcp_at_')) {
        const config = getOAuthConfig();
        const store = getSessionStore();
        oauthAccess = await new OAuthBroker({ config, store }).resolveAccessToken(
          realm,
          bearer,
        );
        backendCredential = oauthAccess.backendAccessJwt;
        baseUrl = sdkBackendBaseUrl(config.realms[realm].backendBaseUrl);
      } else if (bearer?.startsWith('mcp_')) {
        return sendUnauthorized(res, resourceMetadataPath, challengeScope);
      } else {
        backendCredential = bearer || process.env.RESPAN_API_KEY;
        if (!backendCredential) {
          return sendUnauthorized(res, resourceMetadataPath, challengeScope);
        }
        const configuredBaseUrl = (
          realm === 'enterprise'
            ? process.env.RESPAN_ENTERPRISE_API_BASE_URL
            : process.env.RESPAN_API_BASE_URL
        ) || defaultBaseUrl;
        const requestedBaseUrl = (req.headers['respan-api-base-url'] as string)
          || (req.headers['keywords-api-base-url'] as string);
        baseUrl = bearer
          ? resolveAllowedBackendUrl(requestedBaseUrl, configuredBaseUrl)
          : resolveAllowedBackendUrl(undefined, configuredBaseUrl);
        baseUrl = sdkBackendBaseUrl(baseUrl);
      }

      const trackedFetch: typeof fetch = async (input, init) => {
        const response = await globalThis.fetch(input, init);
        if (oauthAccess && response.status === 401) backendUnauthorized = true;
        return response;
      };
      const authenticatedClient: AuthenticatedClient = {
        client: new RespanClient({
          environment: baseUrl,
          ...(oauthAccess ? { fetch: trackedFetch } : {}),
        }),
        auth: `Bearer ${backendCredential}`,
        baseUrl,
        ...(oauthAccess ? { fetch: trackedFetch } : {}),
      };
      const enabledToolsHeader = req.headers['respan-enabled-tools'] as string | undefined;
      const enabledTools = enabledToolsHeader
        ? new Set(enabledToolsHeader.split(',').map((tool) => resolveToolName(tool.trim())).filter(Boolean))
        : undefined;

      // API keys carry their own permissions, enforced by the backend; only a
      // read-only URL narrows them here.
      const isReadOnly = Boolean(options.readOnlyEndpointPath)
        || (oauthAccess ? isReadOnlySession(oauthAccess.session.scope) : false);
      const server = createServer(authenticatedClient, enabledTools, isReadOnly);
      const renamedTools = rewriteToolCallNames(req.body);
      if (renamedTools.length > 0) {
        console.warn(`MCP tools/call used old tool name(s): ${renamedTools.join(', ')}`);
      }
      const blockedCalls = hiddenWriteToolCalls(server, req.body);
      if (blockedCalls) {
        const responses = blockedCalls.map(({ id, name }) => ({
          jsonrpc: '2.0',
          id,
          result: insufficientScopeResult(name, resourceMetadataPath, options.readOnlyEndpointPath),
        }));
        return res.status(200).json(Array.isArray(req.body) ? responses : responses[0]);
      }
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      const transportResponse = await transport.handleRequest(
        toWebRequest(req),
        { parsedBody: req.body },
      );
      const bufferedResponse = await bufferWebResponse(transportResponse);

      if (backendUnauthorized && oauthAccess) {
        await getSessionStore().deleteAccessSession(
          realm,
          oauthAccess.accessTokenHash,
        );
        return sendUnauthorized(res, resourceMetadataPath, challengeScope);
      }
      sendWebResponse(bufferedResponse, res);
    } catch (error) {
      if (
        error instanceof InvalidAccessTokenError
        || (error instanceof Error && error.name === 'ZodError')
      ) {
        return sendUnauthorized(res, resourceMetadataPath, challengeScope);
      }
      if (error instanceof DisallowedBackendUrlError) {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32602, message: 'Invalid backend URL' },
          id: null,
        });
      }
      if (error instanceof SessionStoreUnavailableError) {
        res.setHeader('Retry-After', '5');
        return res.status(503).json({
          jsonrpc: '2.0',
          error: { code: -32002, message: 'Authentication service unavailable' },
          id: null,
        });
      }
      console.error('MCP handler failed');
      if (!res.headersSent) {
        return res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };
}
