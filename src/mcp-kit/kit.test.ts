import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { callTool, createMcpHandler, McpToolError, redact, type McpTool } from './index.js';
import { runContract } from './contract.js';

// Credential-shaped canaries are joined at run time, so no literal in this file looks like a
// real secret to gitleaks. The tests need the shape, not a working credential.
const j = (...parts: string[]) => parts.join('');
const AWS = j('AKI', 'AABCDEFGHIJKLMNOP');
const GH = j('gh', 'p_abcdefghijklmnopqrstuv');
const SKANT = j('sk', '-ant-abcdefghijklmnopqr');
const VAULT = j('hv', 's.CAESIabcdefghijklmnopqr');
const CANARY = 'Bearer abcdef0123456789abcdef';

const tools = new Map<string, McpTool>(
  [
    {
      name: 'echo',
      description: 'Echoes a label and a canary credential, so redaction is proven.',
      input: z.object({ label: z.string().describe('Any label') }),
      tier: 'read',
      run: async ({ label }: { label: string }) => ({ source: '1 fake read', data: { label, header: `authorization: ${CANARY}` } }),
    },
    {
      name: 'broken',
      description: 'Always fails with a caller-safe message.',
      input: z.object({}),
      tier: 'read',
      run: async () => {
        throw new McpToolError('source unreachable');
      },
    },
    {
      name: 'queue_thing',
      description: 'A write tool, hidden unless the server exposes the write tier.',
      input: z.object({}),
      tier: 'write',
      run: async () => ({ source: 'queued', data: {} }),
    },
  ].map((t) => [t.name, t as McpTool]),
);

runContract('fake server', {
  deps: {
    serverInfo: { name: 'petedio-fake', version: '0.0.0' },
    instructions: 'A fake server for the contract suite.',
    path: '/mcp/fake',
    tools,
    allowedPeer: '192.168.50.112',
  },
  okCall: { name: 'echo', arguments: { label: 'some private title' } },
  failCall: { name: 'broken', arguments: {} },
});

describe('redact', () => {
  test('removes bearer values, JWTs, Vault tokens and secret-named values', () => {
    const raw = `Bearer abcdef0123456789 eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl ${VAULT} api_key=sk-12345678 name=pete`;
    const out = redact(raw);
    expect(out.changed).toBe(true);
    expect(out.text).not.toContain('abcdef0123456789');
    expect(out.text).not.toContain('eyJhbGciOi');
    expect(out.text).not.toContain(VAULT);
    expect(out.text).not.toContain('sk-12345678');
    expect(out.text).toContain('name=pete');
  });

  test('leaves plain text alone and reports no change', () => {
    expect(redact('21 guests from Proxmox cluster/resources')).toEqual({ text: '21 guests from Proxmox cluster/resources', changed: false });
  });
});

describe('redact: false positives and missed shapes', () => {
  test('leaves counts, plural names and short words alone', () => {
    for (const ok of ['{"token_count": 12345}', '"tokens": 1234567', '"cf_token_ttl": "3600s"', '"secret": "present"', 'key: value']) {
      expect(redact(ok)).toEqual({ text: ok, changed: false });
    }
  });

  test('leaves prose that mentions basic or bearer alone', () => {
    for (const ok of ['Use basic configuration for the host', 'a Bearer authentication scheme', 'basic setup']) expect(redact(ok)).toEqual({ text: ok, changed: false });
    expect(redact('Basic dXNlcjpwYXNzd29yZA==').changed).toBe(true);
  });

  test('redacts AWS, GitHub and sk- keys, URL credentials, private keys and quoted values with spaces', () => {
    const raw = `${AWS} ${GH} ${SKANT} postgres://u:hunter22pw@h/db ssh_key: abcdefgh12 password: "my secret pw here"\n-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----`;
    const out = redact(raw).text;
    for (const leak of [AWS, GH, SKANT, 'hunter22pw', 'abcdefgh12', 'my secret pw', 'MIIabc']) expect(out).not.toContain(leak);
    expect(out).toContain('postgres://u:[redacted]@h/db');
  });
});

describe('result redaction through the handler', () => {
  test('a canary credential in a result never leaves, and the call logs that it was redacted', async () => {
    const logs: Array<Record<string, unknown> | undefined> = [];
    const h = createMcpHandler({
      serverInfo: { name: 'x', version: '0' }, instructions: 'x', path: '/mcp/x', tools, allowedPeer: '1.2.3.4',
      verify: async () => ({ ok: true, email: 'a@b.c' }), log: (_m, f) => logs.push(f),
    });
    const res = await h(new Request('http://x/mcp/x', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { label: 'a' } } }) }), '1.2.3.4');
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('abcdef0123456789abcdef');
    expect(text).toContain('[redacted]');
    expect(logs.at(-1)?.redacted).toBe(true);
  });
});

describe('errors and the write tier', () => {
  const failing = new Map<string, McpTool>([
    ['leaky', { name: 'leaky', description: 'Fails with a credential in its message.', input: z.object({}), tier: 'read', run: async () => { throw new McpToolError('upstream said Bearer abcdef0123456789abcdef'); } } as McpTool],
    ['queue_thing', tools.get('queue_thing')!],
  ]);
  const make = (tiers?: Array<'read' | 'write'>, logs: Array<Record<string, unknown> | undefined> = []) =>
    createMcpHandler({ serverInfo: { name: 'x', version: '0' }, instructions: 'x', path: '/mcp/x', tools: failing, exposeTiers: tiers, allowedPeer: '1.2.3.4', verify: async () => ({ ok: true, email: 'a@b.c' }), log: (_m, f) => logs.push(f) });
  const call = (h: ReturnType<typeof make>, name: string) => h(new Request('http://x/mcp/x', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }) }), '1.2.3.4');

  test('a credential in an error message is redacted and the error is logged redacted', async () => {
    const logs: Array<Record<string, unknown> | undefined> = [];
    const res = (await (await call(make(undefined, logs), 'leaky')).json()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]!.text).not.toContain('abcdef0123456789abcdef');
    expect(JSON.stringify(logs.at(-1))).not.toContain('abcdef0123456789abcdef');
  });

  test('a write tool runs only when the write tier is exposed', async () => {
    const hidden = (await (await call(make(), 'queue_thing')).json()) as { error?: { message: string } };
    expect(hidden.error?.message).toContain('unknown tool');
    const shown = (await (await call(make(['read', 'write']), 'queue_thing')).json()) as { result: { isError: boolean } };
    expect(shown.result.isError).toBe(false);
  });

  test('an alias answers a call, is logged under the new name and is not listed', async () => {
    const renamed = new Map<string, McpTool>([['get_thing', { name: 'get_thing', aliases: ['old_thing'], description: 'x', input: z.object({}), tier: 'read', run: async () => ({ source: 's', data: 1 }) } as McpTool]]);
    const logs: Array<Record<string, unknown> | undefined> = [];
    const h = createMcpHandler({ serverInfo: { name: 'x', version: '0' }, instructions: 'x', path: '/mcp/x', tools: renamed, allowedPeer: '1.2.3.4', verify: async () => ({ ok: true, email: 'a@b.c' }), log: (_m, f) => logs.push(f) });
    const rpc = (method: string, params: object) => h(new Request('http://x/mcp/x', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), '1.2.3.4');
    const res = (await (await rpc('tools/call', { name: 'old_thing', arguments: {} })).json()) as { result: { isError: boolean } };
    expect(res.result.isError).toBe(false);
    expect(logs.at(-1)).toMatchObject({ tool: 'get_thing', alias: 'old_thing', ok: true });
    const list = (await (await rpc('tools/list', {})).json()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['get_thing']);
  });
  test('nullMeansOmitted drops a null optional key, and a null required key is still missing', async () => {
    const tool = (nullMeansOmitted: boolean): McpTool => ({ name: 't', nullMeansOmitted, description: 'x', input: z.object({ title: z.string(), season: z.number().int().optional() }), tier: 'read', run: async (i) => ({ source: 's', data: i }) });
    expect(await callTool(tool(true), { title: 'X', season: null })).toMatchObject({ ok: true });
    expect(await callTool(tool(true), { title: null })).toMatchObject({ ok: false });
    expect(await callTool(tool(false), { title: 'X', season: null })).toMatchObject({ ok: false });
  });
  test('an object id is refused with 400', async () => {
    const h = createMcpHandler({ serverInfo: { name: 'x', version: '0' }, instructions: 'x', path: '/mcp/x', tools: new Map(), allowedPeer: '1.2.3.4', verify: async () => ({ ok: true, email: 'a@b.c' }) });
    const res = await h(new Request('http://x/mcp/x', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' }) }), '1.2.3.4');
    expect(res.status).toBe(400);
  });
});
