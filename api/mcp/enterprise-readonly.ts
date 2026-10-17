import { createMcpHandler } from '../../lib/shared/mcp-handler.js';

// Read-only tools only, for every credential. See createMcpHandler.
export default createMcpHandler(
  'https://endpoint.respan.ai',
  '/.well-known/oauth-protected-resource/mcp/enterprise/readonly',
  'enterprise',
  { readOnlyEndpointPath: '/mcp/enterprise/readonly' },
);
