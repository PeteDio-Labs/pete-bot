/**
 * The MCP contract suite. A server runs it with `runContract` against a handler built from
 * its own tools, so every PeteDio MCP server proves the same rules:
 * both access checks, tier annotations, unknown and invalid calls, failure as an error,
 * redaction, and no input text in the log.
 *
 * `make` must return a handler whose tools include a `read` tool that succeeds when called
 * with `okCall`, and a `read` tool that fails when called with `failCall`.
 */
import { describe, expect, test } from 'bun:test';
import { createMcpHandler, type McpDeps } from './index.js';

export interface ContractSetup {
  deps: Omit<McpDeps, 'log' | 'verify'>;
  okCall: { name: string; arguments: Record<string, unknown> };
  failCall: { name: string; arguments: Record<string, unknown> };
}

export function runContract(label: string, setup: ContractSetup): void {
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const build = (verifyOk = true, tiers?: McpDeps['exposeTiers']) =>
    createMcpHandler({
      ...setup.deps,
      exposeTiers: tiers,
      verify: async () => (verifyOk ? { ok: true, email: 'pedro@example.com', kind: 'person' } : { ok: false, reason: 'bad token' }),
      log: (msg, fields) => logs.push({ msg, fields }),
    });
  const post = (handler: ReturnType<typeof build>, body: unknown, peer = setup.deps.allowedPeer) =>
    handler(new Request(`http://x${setup.deps.path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), peer);
  const call = (handler: ReturnType<typeof build>, c: { name: string; arguments: Record<string, unknown> }) =>
    post(handler, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: c });

  describe(`MCP contract: ${label}`, () => {
    test('refuses a source that is not the tunnel and runs nothing', async () => {
      const res = await post(build(), { jsonrpc: '2.0', id: 1, method: 'ping' }, '10.9.9.9');
      expect(res.status).toBe(403);
    });

    test('refuses a request whose Access JWT does not verify', async () => {
      const res = await post(build(false), { jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(res.status).toBe(403);
    });

    test('refuses GET and a wrong path', async () => {
      const h = build();
      expect((await h(new Request(`http://x${setup.deps.path}`), setup.deps.allowedPeer)).status).toBe(405);
      expect((await h(new Request('http://x/other', { method: 'POST', body: '{}' }), setup.deps.allowedPeer)).status).toBe(404);
    });

    test('initialize names the server, and a notification gets 202', async () => {
      const h = build();
      const init = (await (await post(h, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json()) as { result: { serverInfo: { name: string }; instructions: string } };
      expect(init.result.serverInfo.name).toBe(setup.deps.serverInfo.name);
      expect(init.result.instructions.length).toBeGreaterThan(0);
      expect((await post(h, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    });

    test('tools/list lists only exposed tiers, and readOnlyHint follows the tier', async () => {
      const readOnly = (await (await post(build(), { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
      expect(readOnly.result.tools.length).toBeGreaterThan(0);
      for (const t of readOnly.result.tools) {
        expect(t.annotations.readOnlyHint).toBe(true);
        expect(setup.deps.tools.get(t.name)?.tier).toBe('read');
      }
      const both = (await (await post(build(true, ['read', 'write']), { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as typeof readOnly;
      for (const t of both.result.tools) expect(t.annotations.readOnlyHint).toBe(setup.deps.tools.get(t.name)?.tier === 'read');
    });

    test('a tool outside the exposed tiers is an unknown tool', async () => {
      const write = [...setup.deps.tools.values()].find((t) => t.tier === 'write');
      expect(write).toBeDefined(); // a server with no write tool must say so by adding one to the suite's fake, not skip the check
      if (!write) return;
      const res = (await (await call(build(), { name: write.name, arguments: {} })).json()) as { error: { message: string } };
      expect(res.error.message).toContain('unknown tool');
    });

    test('an unknown tool is a JSON-RPC error', async () => {
      const res = (await (await call(build(), { name: 'no_such_tool', arguments: {} })).json()) as { error: { code: number } };
      expect(res.error.code).toBe(-32602);
    });

    test('invalid arguments come back as isError with a message', async () => {
      const res = (await (await call(build(), { name: setup.okCall.name, arguments: { not_a_key: 1 } })).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0]!.text.length).toBeGreaterThan(0);
    });

    test('a failed read is an error, never an empty success', async () => {
      const res = (await (await call(build(), setup.failCall)).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0]!.text.length).toBeGreaterThan(0);
    });

    test('a successful call returns text and logs no input text', async () => {
      logs.length = 0;
      const res = (await (await call(build(), setup.okCall)).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
      expect(res.result.isError).toBe(false);
      const entry = logs.find((l) => l.msg === 'mcp call');
      expect(entry?.fields?.inputLength).toBeGreaterThanOrEqual(0);
      for (const v of Object.values(setup.okCall.arguments)) {
        if (typeof v === 'string' && v.length > 0) expect(JSON.stringify(entry)).not.toContain(v);
      }
    });
  });
}
