import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../lib/shared/mcp-handler.js';
import { SERVER_INSTRUCTIONS } from '../lib/shared/instructions.js';

/** Claude Code truncates server instructions past this length. */
const MAX_INSTRUCTIONS_CHARS = 2_048;
/** Codex weighs the start of the instructions most. */
const MAX_FIRST_PARAGRAPH_CHARS = 512;
/** snake_case words ending like our tool names (log_summary, trace_get, log_filter_schema, ...). */
const TOOL_NAME_PATTERN = /\b[a-z]+(?:_[a-z]+)*_(?:summary|list|get|schema)\b/g;

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(null).connect(serverTransport);
  const client = new Client({ name: 'instructions-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('server instructions', () => {
  it('fit what clients read', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
    expect(SERVER_INSTRUCTIONS.split('\n\n')[0].length).toBeLessThanOrEqual(MAX_FIRST_PARAGRAPH_CHARS);
  });

  it('are sent in initialize', async () => {
    const client = await connect();
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    await client.close();
  });

  it('name only tools the server registers', async () => {
    const client = await connect();
    const registered = new Set((await client.listTools()).tools.map((tool) => tool.name));
    await client.close();
    const named = [...new Set(SERVER_INSTRUCTIONS.match(TOOL_NAME_PATTERN) ?? [])];
    expect(named.length).toBeGreaterThan(5);
    expect(named.filter((name) => !registered.has(name))).toEqual([]);
  });

  it('are also set on the stdio server', () => {
    const stdio = readFileSync(new URL('../lib/index.ts', import.meta.url), 'utf8');
    expect(stdio).toContain('instructions: SERVER_INSTRUCTIONS');
  });
});
