import { createMcpHandler } from '../../lib/shared/mcp-handler.js';

// Read-only tools only, for every credential. See createMcpHandler.
export default createMcpHandler(
  'https://api.respan.ai',
  '/.well-known/oauth-protected-resource/mcp/readonly',
  'platform',
  { readOnlyEndpointPath: '/mcp/readonly' },
);
