/**
 * lab-agent (PET-669): settings, the agent loop against a stubbed gateway, the HTTP surface,
 * and pete-bot's client and embed for /lab.
 */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { ask, gatewayCaller, GatewayError, MAX_TOKENS, MAX_TURNS, type CallModel, type ModelResponse } from './agent.js';
import { loadLabConfig } from './config.js';
import { createLabHandler, runChecks } from './server.js';
import { LabToolError, type LabTool } from './tools/index.js';
import { askLab, type LabOutcome } from '../clients/labAgent.js';
import { labEmbed } from '../events/interactionCreate.js';

const ASK = 'a'.repeat(40);
const GW = 'g'.repeat(40);
const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

const baseEnv = {
  LAB_ASK_TOKEN: ASK,
  LAB_GATEWAY_TOKEN: GW,
  LAB_PVE_URL: 'https://192.168.50.10:8006',
  LAB_PVE_TOKEN_ID: 'lab-agent@pve!audit',
  LAB_PVE_TOKEN_SECRET: 'secret-value-123',
  LAB_VAULT_CLONE: '/var/lib/lab-agent/petedio-vault',
  LAB_IAC_CLONE: '/var/lib/lab-agent/petedio-iac',
  LAB_MEDIA_IAC_CLONE: '/var/lib/lab-agent/petedio-media-iac',
  LAB_VAULT_TOKEN: 'hvs.' + 'v'.repeat(24),
  LAB_NOTIFY_TOKEN: 'n'.repeat(40),
};

describe('loadLabConfig', () => {
  it('fills the defaults and reads the CA', () => {
    const cfg = loadLabConfig(baseEnv, () => CA);
    expect(cfg.port).toBe(3016);
    expect(cfg.gateway).toEqual({ url: 'http://127.0.0.1:3015/v1/llm', token: GW, model: 'claude-haiku-4-5' });
    expect(cfg.proxmox.caPem).toBe(CA);
    expect(cfg.kuma).toEqual({ baseUrl: 'http://192.168.50.4:3001', slug: 'fault-study' });
    expect(cfg.vault.addr).toBe('https://192.168.50.223:8200');
    expect(cfg.mcp).toBeNull();
    expect(cfg.plane).toBeNull();
    expect(cfg.drift).toEqual({ notifyUrl: 'http://127.0.0.1:3015/v1/notify', notifyToken: 'n'.repeat(40), at: '11:15' });
  });

  it('turns plane_item on only with a token, and defaults the rest', () => {
    const cfg = loadLabConfig({ ...baseEnv, LAB_PLANE_TOKEN: 'p'.repeat(40) }, () => CA);
    expect(cfg.plane).toEqual({
      baseUrl: 'http://192.168.50.235:8080',
      workspace: 'petedio',
      projectId: '2b962587-cfc8-404d-bbfc-d57c3a60e07f',
      token: 'p'.repeat(40),
    });
    expect(() => loadLabConfig({ ...baseEnv, LAB_PLANE_TOKEN: 'short' }, () => CA)).toThrow('LAB_PLANE_TOKEN');
    expect(loadLabConfig({ ...baseEnv, LAB_PLANE_TOKEN: '' }, () => CA).plane).toBeNull();
  });

  it('turns the MCP door on only with every Access setting', () => {
    const aud = 'a1'.repeat(32);
    expect(() => loadLabConfig({ ...baseEnv, LAB_ACCESS_AUD: aud }, () => CA)).toThrow('LAB_MCP_HOST, LAB_ACCESS_TEAM_DOMAIN, LAB_ACCESS_EMAILS must be too');
    const cfg = loadLabConfig(
      { ...baseEnv, LAB_ACCESS_AUD: aud, LAB_MCP_HOST: '192.168.50.237', LAB_ACCESS_TEAM_DOMAIN: 'petedio.cloudflareaccess.com', LAB_ACCESS_EMAILS: 'Pedelgadillo@gmail.com' },
      () => CA,
    );
    expect(cfg.mcp).toEqual({ host: '192.168.50.237', port: 3017, peer: '192.168.50.112', teamDomain: 'petedio.cloudflareaccess.com', aud, emails: ['pedelgadillo@gmail.com'] });
  });

  it('refuses to start on a missing or short token, and names the field, not the value', () => {
    const err = (() => {
      try {
        loadLabConfig({ ...baseEnv, LAB_ASK_TOKEN: 'short', LAB_GATEWAY_TOKEN: '' }, () => CA);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    expect(err).toContain('LAB_ASK_TOKEN: must be at least 32 characters');
    expect(err).toContain('LAB_GATEWAY_TOKEN');
    expect(err).not.toContain('short');
  });

  it('refuses plain http to Proxmox, a reused bearer, and an unreadable CA', () => {
    expect(() => loadLabConfig({ ...baseEnv, LAB_PVE_URL: 'http://192.168.50.10:8006' }, () => CA)).toThrow('must be https://');
    expect(() => loadLabConfig({ ...baseEnv, LAB_GATEWAY_TOKEN: ASK }, () => CA)).toThrow('must differ');
    expect(() => loadLabConfig({ ...baseEnv, LAB_NOTIFY_TOKEN: GW }, () => CA)).toThrow('LAB_NOTIFY_TOKEN must differ');
    expect(() => loadLabConfig({ ...baseEnv, LAB_DRIFT_AT: '25:00' }, () => CA)).toThrow('must be HH:MM in UTC');
    expect(() =>
      loadLabConfig(baseEnv, () => {
        throw new Error('ENOENT');
      }),
    ).toThrow('cannot read LAB_PVE_CA_FILE');
  });
});

const guestsTool: LabTool = {
  name: 'pve_guests',
  description: 'test',
  input: z.object({}),
  async run() {
    throw new LabToolError('Proxmox refused the token lab-agent@pve!audit (HTTP 401)');
  },
};
const hostTool: LabTool = {
  name: 'find_host',
  description: 'test',
  input: z.object({ query: z.string() }),
  async run({ query }) {
    return { source: '2 host notes', data: { vmid: query } };
  },
};
const tools = new Map([guestsTool, hostTool].map((t) => [t.name, t]));

/** A gateway that plays back responses in order and records each request. */
function scripted(responses: ModelResponse[], seen: Array<Record<string, unknown>> = []): CallModel {
  return async (body) => {
    seen.push(JSON.parse(JSON.stringify(body)));
    const next = responses.shift();
    if (!next) throw new Error('script ran out');
    return next;
  };
}
const toolUse = (id: string, name: string, input: unknown): ModelResponse => ({
  content: [{ type: 'tool_use', id, name, input }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 10 },
});
const final = (text: string): ModelResponse => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 50 } });

describe('ask', () => {
  it('runs the tools the model asks for and returns its answer, with usage', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const result = await ask('where does plane run', tools, scripted([toolUse('t1', 'find_host', { query: '235' }), final('Plane runs on 235.')], seen), 'claude-haiku-4-5');
    expect(result).toMatchObject({ answer: 'Plane runs on 235.', turns: 2, incomplete: false, toolCalls: [{ name: 'find_host', ok: true }] });
    expect(result.usage).toEqual({ input: 300, output: 40, cacheRead: 50 });
    expect(seen[0]).toMatchObject({ model: 'claude-haiku-4-5', max_tokens: MAX_TOKENS });
    const tr = ((seen[1]!.messages as Array<{ content: unknown }>)[2]!.content as Array<Record<string, unknown>>)[0]!;
    expect(tr).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(tr.is_error).toBeUndefined();
    expect(String(tr.content)).toContain('2 host notes');
  });

  it('hands a failed read to the model as an error, not as an empty result', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const result = await ask('is anything down', tools, scripted([toolUse('t1', 'pve_guests', {}), final('The Proxmox read failed: HTTP 401.')], seen), 'm');
    const tr = ((seen[1]!.messages as Array<{ content: unknown }>)[2]!.content as Array<Record<string, unknown>>)[0]!;
    expect(tr).toMatchObject({ is_error: true, content: 'pve_guests: Proxmox refused the token lab-agent@pve!audit (HTTP 401)' });
    expect(result.toolCalls).toEqual([{ name: 'pve_guests', ok: false }]);
    expect(result.answer).toContain('401');
  });

  it('answers an unknown tool name with an error the model sees', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await ask('q', tools, scripted([toolUse('t1', 'shell', { cmd: 'id' }), final('ok')], seen), 'm');
    const tr = ((seen[1]!.messages as Array<{ content: unknown }>)[2]!.content as Array<Record<string, unknown>>)[0]!;
    expect(tr).toMatchObject({ is_error: true, content: 'no tool named shell' });
  });

  it('offers no tools on the last turn, so the model answers from what it read', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const loop = [...Array.from({ length: MAX_TURNS - 1 }, (_, i) => toolUse(`t${i}`, 'find_host', { query: '1' })), final('From what I read: 235.')];
    const result = await ask('q', tools, scripted(loop, seen), 'm');
    expect(seen).toHaveLength(MAX_TURNS);
    expect(seen[MAX_TURNS - 2]!.tool_choice).toBeUndefined();
    expect(seen[MAX_TURNS - 1]!.tool_choice).toEqual({ type: 'none' });
    expect(result).toMatchObject({ answer: 'From what I read: 235.', turns: MAX_TURNS, incomplete: false });
  });

  it('stops at the turn limit and says so if the model still asks for a tool', async () => {
    const loop = Array.from({ length: MAX_TURNS + 2 }, (_, i) => toolUse(`t${i}`, 'find_host', { query: '1' }));
    const result = await ask('q', tools, scripted(loop), 'm');
    expect(result.incomplete).toBe(true);
    expect(result.turns).toBe(MAX_TURNS);
    expect(result.toolCalls).toHaveLength(MAX_TURNS - 1);
    expect(result.answer).toContain(`stopped after ${MAX_TURNS} model turns`);
  });

  it('marks an answer cut at the output limit, refused or empty as incomplete', async () => {
    const cut = await ask('q', tools, scripted([{ content: [{ type: 'text', text: 'Plane runs' }], stop_reason: 'max_tokens' }]), 'm');
    expect(cut).toMatchObject({ answer: 'Plane runs\n\n(Answer cut at the output limit.)', incomplete: true });
    const empty = await ask('q', tools, scripted([{ content: [], stop_reason: 'end_turn' }]), 'm');
    expect(empty).toMatchObject({ answer: '(The model returned no text.)', incomplete: true });
    const refused = await ask('q', tools, scripted([{ content: [], stop_reason: 'refusal' }]), 'm');
    expect(refused.incomplete).toBe(true);
  });

  it('stops at the deadline instead of spending more turns', async () => {
    const controller = new AbortController();
    const call: CallModel = async () => {
      controller.abort();
      return toolUse('t1', 'find_host', { query: '1' });
    };
    const result = await ask('q', tools, call, 'm', controller.signal);
    expect(result).toMatchObject({ turns: 1, incomplete: true });
    expect(result.answer).toContain('the deadline passed');
  });

  it('counts missing usage fields as zero', async () => {
    const result = await ask('q', tools, scripted([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]), 'm');
    expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0 });
  });

  it('caches the system prompt and the tool list', async () => {
    const seen: Array<Record<string, unknown>> = [];
    await ask('q', tools, scripted([final('ok')], seen), 'm');
    const sentTools = seen[0]!.tools as Array<Record<string, unknown>>;
    expect(sentTools.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
    expect(sentTools[0]!.cache_control).toBeUndefined();
    expect((seen[0]!.system as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('gatewayCaller', () => {
  it('posts to the gateway as the lab-map caller', async () => {
    let got: { url: string; init?: RequestInit } | null = null;
    const call = gatewayCaller('http://127.0.0.1:3015/v1/llm', GW, (async (url: string, init?: RequestInit) => {
      got = { url, init };
      return new Response(JSON.stringify(final('hi')));
    }) as unknown as typeof fetch);
    expect((await call({ model: 'm' })).content[0]!.text).toBe('hi');
    expect(got!.url).toBe('http://127.0.0.1:3015/v1/llm/v1/messages');
    expect((got!.init!.headers as Record<string, string>).authorization).toBe(`Bearer ${GW}`);
  });

  it("passes the gateway's refusal reason on", async () => {
    const call = gatewayCaller('http://x', GW, (async () =>
      new Response(JSON.stringify({ error: { message: 'caller lab-map is at its monthly cap' } }), { status: 403 })) as unknown as typeof fetch);
    await expect(call({})).rejects.toThrow(new GatewayError('gateway answered HTTP 403: caller lab-map is at its monthly cap'));
  });
});

describe('lab-agent HTTP surface', () => {
  const up = async () => 'fine';
  const handler = (overrides: Partial<Parameters<typeof createLabHandler>[0]> = {}) =>
    createLabHandler({ askToken: ASK, tools, callModel: scripted([final('Plane runs on 235.')]), model: 'm', checks: { gateway: up }, ...overrides });
  const post = (body: unknown, token = ASK) =>
    new Request('http://127.0.0.1:3016/v1/ask', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

  it('answers a question with the right bearer', async () => {
    const res = await handler()(post({ question: 'where does plane run' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ answer: 'Plane runs on 235.', turns: 1 });
  });

  it('refuses a wrong or missing bearer, a bad body and a GET', async () => {
    const h = handler();
    expect((await h(post({ question: 'where does plane run' }, 'b'.repeat(40)))).status).toBe(401);
    expect((await h(new Request('http://x/v1/ask', { method: 'POST', body: '{}' }))).status).toBe(401);
    expect((await h(post({ question: 'x' }))).status).toBe(400);
    expect((await h(post({ question: 'where', extra: 1 }))).status).toBe(400);
    expect((await h(new Request('http://x/v1/ask'))).status).toBe(405);
  });

  it('refuses a second question while one runs', async () => {
    let release!: () => void;
    const slow: CallModel = () => new Promise((resolve) => (release = () => resolve(final('done'))));
    const h = handler({ callModel: slow });
    const first = h(post({ question: 'first question' }));
    await Bun.sleep(5);
    expect((await h(post({ question: 'second question' }))).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
  });

  it('frees the question slot when the deadline passes', async () => {
    let calls = 0;
    const hangOnce: CallModel = (_b, signal) =>
      ++calls === 1
        ? new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new GatewayError('stopped'))))
        : Promise.resolve(final('second answer'));
    const h = handler({ callModel: hangOnce, deadlineMs: 20 });
    const res = await h(post({ question: 'where does plane run' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ incomplete: true });
    const second = await h(post({ question: 'second question' }));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ answer: 'second answer' });
  });

  it('turns a gateway refusal into a 502 with its reason', async () => {
    const h = handler({ callModel: async () => { throw new GatewayError('gateway answered HTTP 403: cap reached'); } });
    const res = await h(post({ question: 'where does plane run' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'gateway answered HTTP 403: cap reached' });
  });

  it('reports health per dependency, and 503 when one is down', async () => {
    const h = handler({ checks: { gateway: up, proxmox: async () => { throw new Error('HTTP 401'); } } });
    const res = await h(new Request('http://x/health'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: 'degraded',
      ok: false,
      checks: { gateway: { up: true, detail: 'fine' }, proxmox: { up: false, detail: 'HTTP 401' } },
    });
  });

  it('never reports healthy with no checks at all', async () => {
    expect((await runChecks({})).ok).toBe(false);
  });
});

describe('/lab in pete-bot', () => {
  const cfg = { url: 'http://127.0.0.1:3016', token: ASK, timeoutMs: 1000 };

  it('says not configured when there is no token, without calling anything', async () => {
    let called = false;
    const out = await askLab('q', { ...cfg, token: '' }, (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch);
    expect(out).toEqual({ kind: 'not-configured' });
    expect(called).toBe(false);
  });

  it('relays an answer and sends only the ask bearer', async () => {
    let headers: Record<string, string> = {};
    const out = await askLab('where does plane run', cfg, (async (_u: string, init?: RequestInit) => {
      headers = init!.headers as Record<string, string>;
      return new Response(JSON.stringify({ answer: 'Plane runs on 235.', turns: 2, toolCalls: [{ name: 'find_host', ok: true }], incomplete: false, usage: { input: 1, output: 2, cacheRead: 0 } }));
    }) as unknown as typeof fetch);
    expect(out.kind).toBe('answer');
    expect(headers.authorization).toBe(`Bearer ${ASK}`);
    const partial = await askLab('q', cfg, (async () => new Response(JSON.stringify({ answer: 'x', usage: { input: 3 } }))) as unknown as typeof fetch);
    expect(partial.kind === 'answer' && partial.result.usage).toEqual({ input: 3, output: 0, cacheRead: 0 });
  });

  it('turns an unreachable lab-agent or an error status into a failure with its reason', async () => {
    const down = await askLab('q', cfg, (() => Promise.reject(new TypeError('connect ECONNREFUSED'))) as unknown as typeof fetch);
    expect(down).toEqual({ kind: 'failed', reason: 'lab-agent unreachable (connect ECONNREFUSED)' });
    const busy = await askLab('q', cfg, (async () => new Response(JSON.stringify({ error: 'a question is already running' }), { status: 429 })) as unknown as typeof fetch);
    expect(busy).toEqual({ kind: 'failed', reason: 'lab-agent answered HTTP 429: a question is already running' });
  });

  it('colours an answer with a failed read yellow and names the tools', () => {
    const outcome: LabOutcome = {
      kind: 'answer',
      result: { answer: 'Proxmox read failed.', turns: 2, toolCalls: [{ name: 'pve_guests', ok: false }, { name: 'find_host', ok: true }], incomplete: false, usage: { input: 10, output: 5, cacheRead: 0 } },
    };
    const embed = labEmbed('is anything down', outcome).toJSON();
    expect(embed.color).toBe(0xfee75c);
    expect(embed.footer?.text).toBe('2 turns · tools: pve_guests, find_host (1 failed) · 10 in / 5 out tokens');
    expect(labEmbed('q', { kind: 'failed', reason: 'boom' }).toJSON().color).toBe(0xed4245);
  });
});
