import type { VercelRequest, VercelResponse } from '@vercel/node';
import { MCP_READ_SCOPE } from '../../lib/oauth/scopes.js';

// Metadata for the read-only URL: only read scope is ever granted for it.
export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'MCP-Protocol-Version');

  if (_req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const origin = (process.env.MCP_PUBLIC_BASE_URL || 'https://mcp.respan.ai').replace(/\/+$/, '');

  return res.status(200).json({
    resource: `${origin}/mcp/enterprise/readonly`,
    authorization_servers: [`${origin}/enterprise-oauth`],
    scopes_supported: [MCP_READ_SCOPE],
  });
}
