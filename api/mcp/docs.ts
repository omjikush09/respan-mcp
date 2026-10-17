import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createDocsServer } from '../../lib/docs/tools.js';
import { rewriteToolCallNames } from '../../lib/shared/tool-aliases.js';
import {
  noteAliasedCalls,
  recordRequest,
  telemetryContext,
} from '../../lib/shared/telemetry.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  try {
// The docs server needs no credential, so every caller counts as 'none'.
    const telemetry = telemetryContext('docs', undefined, req.headers, false);
    const server = createDocsServer(telemetry);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);

    noteAliasedCalls(telemetry, req.body);
    const renamedTools = rewriteToolCallNames(req.body);
    await transport.handleRequest(
      req as any,
      res as any,
      req.body,
    );
    recordRequest(server, telemetry, req.body, renamedTools, res.statusCode < 400);
  } catch (error) {
    console.error('Docs MCP Handler error:', error);

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
}
