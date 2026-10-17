// lib/oauth/scopes.ts
//
// What an OAuth connection may do. `mcp:read` is every connection's baseline:
// it reaches the tools annotated readOnlyHint. `mcp:write` adds every other
// tool (create, update, deploy, delete) and is granted only when the user
// ticks "Also allow changes" on the consent page.
//
// Scope strings use OAuth's space-separated form. A scope only ever narrows on
// its way from request to consent to code to token to refresh; it never grows.

export const MCP_READ_SCOPE = 'mcp:read';
export const MCP_WRITE_SCOPE = 'mcp:write';
export const SUPPORTED_SCOPES = [MCP_READ_SCOPE, MCP_WRITE_SCOPE] as const;

/** Sessions issued before scopes existed carry none; this env var decides them. */
export const LEGACY_SCOPE_ENV = 'MCP_LEGACY_SCOPE';
function formatScope(scopes: Iterable<string>): string {
  const have = new Set(scopes);
  return SUPPORTED_SCOPES.filter((scope) => have.has(scope)).join(' ');
}

function scopeSet(scope: string | undefined): Set<string> {
  return new Set((scope ?? '').split(/\s+/).filter(Boolean));
}

/**
 * The scopes a client asked for at /authorize. Clients that send no `scope`
 * are treated as asking for everything, so the user still decides at consent.
 * Unknown values are dropped, and read is always included. A scope made only of
 * values this server does not define (claude.ai sends `claudeai`) says nothing
 * about read vs write, so it is treated like a missing one.
 */
export function requestedScope(raw: string | undefined): string {
  const asked = scopeSet(raw);
  if (!SUPPORTED_SCOPES.some((scope) => asked.has(scope))) return formatScope(SUPPORTED_SCOPES);
  asked.add(MCP_READ_SCOPE);
  return formatScope(asked);
}

/** What consent grants: read, plus write only if asked for and approved. */
export function grantedScope(requested: string | undefined, isWriteApproved: boolean): string {
  const granted = new Set([MCP_READ_SCOPE]);
  if (isWriteApproved && hasWriteScope(requested ?? formatScope(SUPPORTED_SCOPES))) {
    granted.add(MCP_WRITE_SCOPE);
  }
  return formatScope(granted);
}

export function hasWriteScope(scope: string | undefined): boolean {
  return scopeSet(scope).has(MCP_WRITE_SCOPE);
}

/**
 * Whether a session may only use read-only tools. A scoped session is read-only
 * unless it holds mcp:write. A legacy session (no scope recorded) keeps the
 * full access it was granted, unless MCP_LEGACY_SCOPE is set. The only reason to
 * set it is to cut legacy sessions back, so any non-empty value (documented as
 * `read`) makes them read-only; a misspelling fails closed, not open.
 */
export function isReadOnlySession(
  scope: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (scope === undefined) return (env[LEGACY_SCOPE_ENV] ?? '').trim() !== '';
  return !hasWriteScope(scope);
}
