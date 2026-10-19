/**
 * The lab MCP (PET-667): the Access JWT check, the MCP door, and the three tools phase 1
 * adds (desk_status, systemd_status, vault_presence).
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { AccessVerifier } from './access.js';
import { createMcpHandler, MCP_PATH, normalizePeer } from './mcp.js';
import { deskStatusTool, parseShow, systemdStatusTool } from './tools/local.js';
import { callTool, LabToolError, type LabTool, type ToolResult } from './tools/types.js';
import { VaultMetadataClient, vaultPresenceTool } from './tools/vault.js';

const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const TEAM = 'petedio.cloudflareaccess.com';
const AUD = 'ab'.repeat(32);
const NOW = 1_800_000_000_000;

function data(r: ToolResult): { source: string; data: Record<string, unknown> } {
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return JSON.parse(r.text);
}
function error(r: ToolResult): string {
  if (r.ok) throw new Error(`expected an error, got: ${r.text}`);
  return r.error;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let privateKey: KeyObject;
let jwks: { keys: unknown[] };
beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }] };
});

function sign(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }, key = privateKey): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const body = `${enc(header)}.${enc(payload)}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(key).toString('base64url')}`;
}
const good = (over: Record<string, unknown> = {}) =>
  sign({ aud: [AUD], iss: `https://${TEAM}`, email: 'pedelgadillo@gmail.com', exp: NOW / 1000 + 300, nbf: NOW / 1000 - 10, ...over });

function verifier(fetchCount = { n: 0 }) {
  return new AccessVerifier({
    teamDomain: TEAM,
    aud: AUD,
    emails: ['pedelgadillo@gmail.com'],
    now: () => NOW,
    fetch: (async (url: string) => {
      fetchCount.n++;
      expect(url).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
      return json(jwks);
    }) as unknown as typeof fetch,
  });
}

describe('AccessVerifier', () => {
  it("accepts Pedro's token and caches the keys", async () => {
    const count = { n: 0 };
    const v = verifier(count);
    expect(await v.verify(good())).toEqual({ ok: true, email: 'pedelgadillo@gmail.com' });
    expect(await v.verify(good())).toEqual({ ok: true, email: 'pedelgadillo@gmail.com' });
    expect(count.n).toBe(1);
  });

  it('refuses every way a token can be wrong', async () => {
    const v = verifier();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const cases: Array<[string | null, string]> = [
      [null, 'no Cf-Access-Jwt-Assertion header'],
      ['a.b', 'malformed JWT'],
      [good({ aud: ['cd'.repeat(32)] }), 'JWT is for another Access application'],
      [good({ iss: 'https://evil.cloudflareaccess.com' }), 'JWT has the wrong issuer'],
      [good({ exp: NOW / 1000 - 120 }), 'JWT expired'],
      [good({ nbf: NOW / 1000 + 600 }), 'JWT not yet valid'],
      [good({ email: 'someone@else.com' }), 'email not allowed'],
      [sign({ aud: [AUD] }, { alg: 'none', kid: 'k1' }), 'JWT is not RS256 with a kid'],
      [sign({ aud: [AUD] }, { alg: 'HS256', kid: 'k1' }), 'JWT is not RS256 with a kid'],
      [sign({ aud: [AUD] }, { alg: 'RS256', kid: 'k9' }), 'JWT signed by an unknown key'],
      ['bnVsbA.bnVsbA.x', 'malformed JWT'],
      [sign({ aud: [AUD], iss: `https://${TEAM}`, email: 'pedelgadillo@gmail.com', exp: NOW / 1000 + 300 }, undefined, other), 'bad JWT signature'],
    ];
    for (const [token, reason] of cases) expect(await v.verify(token)).toEqual({ ok: false, reason });
  });

  it('keeps its keys when a refetch answers with none', async () => {
    let now = NOW;
    let answer: unknown = jwks;
    const v = new AccessVerifier({ teamDomain: TEAM, aud: AUD, emails: ['pedelgadillo@gmail.com'], now: () => now, fetch: (async () => json(answer)) as unknown as typeof fetch });
    expect((await v.verify(good())).ok).toBe(true);
    answer = { keys: [] };
    now += 11 * 60_000;
    const later = sign({ aud: [AUD], iss: `https://${TEAM}`, email: 'pedelgadillo@gmail.com', exp: now / 1000 + 300 });
    expect((await v.verify(later)).ok).toBe(true);
    expect(await v.verify(sign({ aud: [AUD] }, { alg: 'RS256', kid: 'k9' }))).toEqual({ ok: false, reason: 'JWT signed by an unknown key' });
  });

  it('refuses everything when the certs cannot be read', async () => {
    const v = new AccessVerifier({ teamDomain: TEAM, aud: AUD, emails: ['a@b.c'], now: () => NOW, fetch: (async () => json({}, 500)) as unknown as typeof fetch });
    expect(await v.verify(good())).toEqual({ ok: false, reason: 'cannot read Access certs: Access certs answered HTTP 500' });
  });
});

describe('the MCP door', () => {
  const echo: LabTool = {
    name: 'find_host',
    description: 'test tool',
    input: z.object({ query: z.string() }),
    async run({ query }) {
      if (query === 'fail') throw new LabToolError('vault clone unreadable');
      return { source: 'test', data: { query } };
    },
  };
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const handler = createMcpHandler({
    tools: new Map([[echo.name, echo]]),
    allowedPeer: '192.168.50.112',
    verify: async (jwt) => (jwt === 'good' ? { ok: true, email: 'pedelgadillo@gmail.com' } : { ok: false, reason: 'bad' }),
    log: (msg, fields) => logs.push({ msg, fields }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Rpc = any;
  const rpc = async (body: unknown): Promise<Rpc> => (await call(body)).json();
  const call = (body: unknown, { jwt = 'good', peer = '::ffff:192.168.50.112', method = 'POST', path = MCP_PATH } = {}) =>
    handler(
      new Request(`http://192.168.50.237:3017${path}`, {
        method,
        headers: { 'cf-access-jwt-assertion': jwt, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      }),
      peer,
    );

  it('refuses any source but the tunnel host, and any request without a good JWT', async () => {
    expect((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, { peer: '192.168.50.20' })).status).toBe(403);
    expect((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, { jwt: 'bad' })).status).toBe(403);
    expect(logs.at(-1)).toEqual({ msg: 'mcp refused', fields: { reason: 'bad', source: '192.168.50.112' } });
  });

  it('answers initialize with a version it supports', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(res.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'petedio-lab' } });
    const old = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    expect(old.result.protocolVersion).toBe('2025-11-25');
  });

  it('lists the tools as read-only, with their schemas', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(res.result.tools).toEqual([
      {
        name: 'find_host',
        description: 'test tool',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
    ]);
  });

  it('runs a tool, logs who called it, and marks a failed read as an error', async () => {
    const ok = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'find_host', arguments: { query: '235' } } });
    expect(ok.result.isError).toBe(false);
    expect(JSON.parse(ok.result.content[0].text)).toEqual({ source: 'test', data: { query: '235' } });
    expect(logs.at(-1)?.fields).toMatchObject({ email: 'pedelgadillo@gmail.com', tool: 'find_host', input: { query: '235' }, ok: true });

    const bad = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'find_host', arguments: { query: 'fail' } } });
    expect(bad.result).toEqual({ content: [{ type: 'text', text: 'find_host: vault clone unreadable' }], isError: true });
  });

  it('refuses an unknown tool or method, a GET, a batch and a bad body', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'shell' } })).error.code).toBe(-32602);
    expect((await rpc({ jsonrpc: '2.0', id: 7, method: 'resources/list' })).error.code).toBe(-32601);
    expect((await call(null, { method: 'GET' })).status).toBe(405);
    expect((await call([{ jsonrpc: '2.0', id: 8, method: 'ping' }])).status).toBe(400);
    expect((await call({ id: 9, method: 'ping' })).status).toBe(400);
    expect((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, { path: '/mcp/plane' })).status).toBe(404);
  });

  it('refuses a protocol version it never offered', async () => {
    const res = await handler(
      new Request(`http://192.168.50.237:3017${MCP_PATH}`, {
        method: 'POST',
        headers: { 'cf-access-jwt-assertion': 'good', 'mcp-protocol-version': '1999-01-01' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      }),
      '192.168.50.112',
    );
    expect(res.status).toBe(400);
  });

  it('accepts a notification with 202 and no body', async () => {
    const res = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  it('reads an IPv4-mapped peer as its IPv4 address', () => {
    expect(normalizePeer('::ffff:192.168.50.112')).toBe('192.168.50.112');
    expect(normalizePeer(undefined)).toBe('');
  });
});

describe('desk_status', () => {
  it("returns the desk's state from pete-bot's /health", async () => {
    const tool = deskStatusTool({
      healthUrl: 'http://127.0.0.1:3015/health',
      fetch: (async () => json({ ok: true, llm: 'on', uptimeSeconds: 60, desk: { state: 'running', mode: 'on', lastPollPrs: 4 } })) as unknown as typeof fetch,
    });
    expect(data(await callTool(tool, {})).data).toEqual({ desk: { state: 'running', mode: 'on', lastPollPrs: 4 }, llm: 'on', peteBotUptimeSec: 60 });
  });

  it('reports pete-bot down or a health answer with no desk as an error', async () => {
    const down = deskStatusTool({ healthUrl: 'http://x/health', fetch: (() => Promise.reject(new TypeError('ECONNREFUSED'))) as unknown as typeof fetch });
    expect(error(await callTool(down, {}))).toContain('unreachable (ECONNREFUSED)');
    const nodesk = deskStatusTool({ healthUrl: 'http://x/health', fetch: (async () => json({ ok: true })) as unknown as typeof fetch });
    expect(error(await callTool(nodesk, {}))).toContain('carries no desk field');
  });
});

describe('systemd_status', () => {
  const SHOW = 'Id=pete-bot.service\nLoadState=loaded\nActiveState=active\nSubState=running\nActiveEnterTimestamp=Mon 2026-10-19 07:13:01 UTC\nNRestarts=0\nResult=success\n\nId=lab-agent.service\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nActiveEnterTimestamp=\nNRestarts=0\nResult=success\n';

  it('reads only the fixed units, with options after --', async () => {
    let args: string[] = [];
    const tool = systemdStatusTool(['pete-bot.service', 'lab-agent.service'], async (a) => ((args = a), SHOW));
    const out = data(await callTool(tool, {}));
    expect(args.slice(-3)).toEqual(['--', 'pete-bot.service', 'lab-agent.service']);
    expect(out.data.units).toEqual([
      { unit: 'pete-bot.service', loaded: 'loaded', active: 'active', sub: 'running', since: 'Mon 2026-10-19 07:13:01 UTC', restarts: 0, result: 'success' },
      { unit: 'lab-agent.service', loaded: 'not-found', active: 'inactive', sub: 'dead', since: null, restarts: 0, result: 'success' },
    ]);
    expect(error(await callTool(tool, { unit: 'sshd.service' }))).toContain('invalid input: unit');
  });

  it('reports a systemctl failure or a short answer as an error', async () => {
    const failing = systemdStatusTool(['pete-bot.service'], async () => {
      throw new Error('systemctl exited 1: Failed to connect to bus');
    });
    expect(error(await callTool(failing, {}))).toContain('Failed to connect to bus');
    const short = systemdStatusTool(['pete-bot.service', 'lab-agent.service'], async () => 'Id=pete-bot.service\nActiveState=active\n');
    expect(error(await callTool(short, {}))).toContain('showed 1 units for 2 asked');
  });

  it('refuses a unit name that is not a plain unit at build time', () => {
    expect(() => systemdStatusTool(['--all'])).toThrow('bad unit name');
    expect(parseShow('Id=a.service\nX=1')).toEqual([{ Id: 'a.service', X: '1' }]);
  });
});

describe('vault_presence', () => {
  const routes = (map: Record<string, Response | (() => Response)>, seen: Array<{ url: string; init?: RequestInit }> = []) =>
    (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      const key = `${init?.method} ${url.replace('https://192.168.50.223:8200', '')}`;
      // Bun's fetch would send a custom LIST method as GET; the client must never try it.
      expect(init?.method).toBe('GET');
      const r = map[key];
      return r ? (typeof r === 'function' ? r() : r.clone()) : json({ errors: [] }, 404);
    }) as unknown as typeof fetch;
  const cfg = { addr: 'https://192.168.50.223:8200', token: 'hvs.token', caPem: CA };

  it('lists names from metadata only, with the token and the CA', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const tool = vaultPresenceTool(new VaultMetadataClient({ ...cfg, fetch: routes({ 'GET /v1/kv/metadata/services/?list=true': json({ data: { keys: ['lab-agent', 'pete-bot'] } }) }, seen) }));
    const out = data(await callTool(tool, {}));
    expect(out).toEqual({ source: '2 entries listed under kv/metadata/services/', data: { secrets: ['lab-agent', 'pete-bot'] } });
    expect((seen[0]!.init!.headers as Record<string, string>)['X-Vault-Token']).toBe('hvs.token');
    expect((seen[0]!.init as { tls?: { ca?: string } }).tls?.ca).toBe(CA);
    expect(seen.every((s) => !s.url.includes('/data/'))).toBe(true);
  });

  it("returns one secret's versions and never a value", async () => {
    const md = { current_version: 4, created_time: '2026-10-01T00:00:00Z', updated_time: '2026-10-19T06:53:22Z', versions: { '3': { created_time: 'a' }, '4': { created_time: '2026-10-19T06:53:22Z' } } };
    const tool = vaultPresenceTool(new VaultMetadataClient({ ...cfg, fetch: routes({ 'GET /v1/kv/metadata/services/pete-bot': json({ data: md }) }) }));
    const out = data(await callTool(tool, { name: 'pete-bot' }));
    expect(out.data).toMatchObject({ name: 'pete-bot', exists: true, currentVersion: 4, updated: '2026-10-19T06:53:22Z' });
    expect((out.data.recentVersions as Array<{ version: number }>).map((v) => v.version)).toEqual([4, 3]);
    const missing = vaultPresenceTool(new VaultMetadataClient({ ...cfg, fetch: routes({}) }));
    expect(data(await callTool(missing, { name: 'nope' })).data).toEqual({ name: 'nope', exists: false });
    const hollow = vaultPresenceTool(new VaultMetadataClient({ ...cfg, fetch: routes({ 'GET /v1/kv/metadata/services/odd': json({}) }) }));
    expect(error(await callTool(hollow, { name: 'odd' }))).toContain('answered 200 with no data');
  });

  it('says sealed, refused or empty, never "0 secrets"', async () => {
    const sealed = vaultPresenceTool(new VaultMetadataClient({ ...cfg, fetch: routes({ 'GET /v1/kv/metadata/services/?list=true': json({}, 503) }) }));
    expect(error(await callTool(sealed, {}))).toContain('Vault is sealed');
    const refused = vaultPresenceTool(new VaultMetadataClient({ ...cfg, fetch: routes({ 'GET /v1/kv/metadata/services/?list=true': json({}, 403) }) }));
    expect(error(await callTool(refused, {}))).toContain('HTTP 403');
    const empty = vaultPresenceTool(new VaultMetadataClient({ ...cfg, fetch: routes({ 'GET /v1/kv/metadata/services/?list=true': json({ data: { keys: [] } }) }) }));
    expect(error(await callTool(empty, {}))).toContain('listed 0 secrets');
  });

  it('refuses a name that could leave services/', async () => {
    const tool = vaultPresenceTool(new VaultMetadataClient({ ...cfg, fetch: routes({}) }));
    for (const name of ['../iac/proxmox', 'a/b', 'IAC']) expect(error(await callTool(tool, { name }))).toContain('invalid input: name');
  });

  it('refuses plain http and a missing CA', () => {
    expect(() => new VaultMetadataClient({ ...cfg, addr: 'http://192.168.50.223:8200' })).toThrow('https://');
    expect(() => new VaultMetadataClient({ ...cfg, caPem: '' })).toThrow('CA PEM');
  });
});
