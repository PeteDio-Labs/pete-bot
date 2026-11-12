/**
 * The media assistant's lab-agent side (PET-869): the mtrace tools, the history the loop
 * carries, and POST /v1/media/ask.
 */
import { describe, expect, it, vi } from 'bun:test';
import { z } from 'zod';
import { ask, MEDIA_SYSTEM_PROMPT, type CallModel, type ModelResponse } from './agent.js';
import { loadLabConfig } from './config.js';
import { createLabHandler } from './server.js';
import { callTool, inputJsonSchema, type LabTool } from './tools/index.js';
import { MTRACE_SPECS, mtraceTools } from './tools/mtrace.js';

const ASK = 'a'.repeat(40);
const CFG = { baseUrl: 'http://192.168.50.237:8237/', token: 'm'.repeat(40) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const find = (name: string, fetchImpl: typeof fetch) => mtraceTools({ ...CFG, fetch: fetchImpl }).find((t) => t.name === name)!;

describe('mtrace tools', () => {
  it('offers exactly the ten read tools', () => {
    expect(MTRACE_SPECS.map((s) => s.name).sort()).toEqual(
      ['library', 'list_queue', 'now_playing', 'partial_files', 'queue_errors', 'seerr_drift', 'stale_versions', 'trace_request', 'vpn_health', 'why_is_it_dead'],
    );
  });

  it('turns every input into a JSON Schema the model can be offered', () => {
    for (const s of MTRACE_SPECS) expect(inputJsonSchema(s.input)).toMatchObject({ type: 'object', additionalProperties: false });
    expect(inputJsonSchema(find('trace_request', fetch).input)).toMatchObject({ required: ['title'] });
  });

  it('drops an extra key on a no-argument tool instead of refusing the call', async () => {
    const f = vi.fn().mockResolvedValue(json({ ok: true, text: 'queue empty', toolMs: 1 }));
    const res = await callTool(find('list_queue', f as never), { title: 'The Body' });
    expect(res.ok).toBe(true);
    expect(JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string)).toEqual({});
  });

  it('posts to the tool route with the bearer and the arguments, and names what it read', async () => {
    const f = vi.fn().mockResolvedValue(json({ ok: true, text: 'Survivor — partially-available (190 of 192 on disk)', toolMs: 1183 }));
    const res = await callTool(find('trace_request', f as never), { title: 'Survivor', season: 50 });
    expect(res.ok).toBe(true);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://192.168.50.237:8237/api/tool/trace_request');
    expect((init as RequestInit).headers).toMatchObject({ authorization: `Bearer ${CFG.token}` });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ title: 'Survivor', season: 50 });
    expect(res.ok && res.text).toContain('mtrace trace_request');
    expect(res.ok && res.text).toContain('190 of 192');
  });

  it('refuses a call without the required title and an unknown argument, before any request', async () => {
    const f = vi.fn();
    expect((await callTool(find('trace_request', f as never), {})).ok).toBe(false);
    expect((await callTool(find('list_queue', f as never), { shell: 'rm -rf /' })).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('passes an ok=false finding to the model as data, and marks it', async () => {
    const f = vi.fn().mockResolvedValue(json({ ok: false, error: 'sonarr is not answering' }));
    const res = await callTool(find('list_queue', f as never), {});
    expect(res.ok).toBe(true);
    expect(res.ok && res.text).toContain('sonarr is not answering');
    expect(res.ok && res.text).toContain('ok=false');
  });

  it.each([
    ['401', json({ ok: false }, 401), 'refused the lab-agent token'],
    ['404', json({ ok: false }, 404), 'tool list has drifted'],
    ['500', json({ ok: false }, 500), 'HTTP 500'],
    ['a non-JSON body', new Response('<html>', { status: 200 }), 'not JSON'],
    ['a JSON array', json([1, 2]), 'not an object'],
  ])('fails on %s', async (_n, response, expected) => {
    const res = await callTool(find('vpn_health', (async () => response) as never), {});
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain(expected);
  });

  it('fails when mtrace is unreachable', async () => {
    const res = await callTool(find('vpn_health', (async () => { throw new Error('ECONNRESET'); }) as never), {});
    expect(!res.ok && res.error).toContain('unreachable (ECONNRESET)');
  });
});

function scripted(responses: ModelResponse[], seen: Array<Record<string, unknown>> = []): CallModel {
  let i = 0;
  return async (body) => {
    seen.push(JSON.parse(JSON.stringify(body)));
    const r = responses[i++];
    if (!r) throw new Error('script exhausted');
    return r;
  };
}
const final = (text: string): ModelResponse => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });

describe('the media loop', () => {
  it('sends the media prompt and the earlier turns before the question', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const tool: LabTool = { name: 'list_queue', description: 'd', input: z.object({}), run: async () => ({ source: 's', data: {} }) };
    await ask(
      'and the next episode?',
      new Map([[tool.name, tool]]),
      scripted([final('Episode 2 is queued.')], seen),
      'm',
      undefined,
      { system: MEDIA_SYSTEM_PROMPT, history: [{ role: 'user', content: 'why is Survivor stuck' }, { role: 'assistant', content: 'Episode 1 failed to import.' }] },
    );
    const body = seen[0]!;
    expect((body.system as Array<{ text: string }>)[0]!.text).toContain("Pedro's media assistant");
    expect(body.messages).toEqual([
      { role: 'user', content: 'why is Survivor stuck' },
      { role: 'assistant', content: 'Episode 1 failed to import.' },
      { role: 'user', content: 'and the next episode?' },
    ]);
  });
});

describe('download ETA follow-ups', () => {
  for (const q of ["how long until it's downloaded", 'show me the latest downloads', 'what finished downloading recently']) {
    it(`offers list_queue and carries the earlier turns for "${q}"`, async () => {
      const seen: Array<Record<string, unknown>> = [];
      const run = vi.fn(async () => ({ source: 'mtrace list_queue', data: { text: 'Coco 37.8%, ETA 45m' } }));
      const tool: LabTool = { name: 'list_queue', description: 'd', input: z.object({}), run };
      const out = await ask(
        q,
        new Map([[tool.name, tool]]),
        scripted([{ content: [{ type: 'tool_use', id: 't1', name: 'list_queue', input: {} }], stop_reason: 'tool_use' }, final('Coco: ETA 45m.')], seen),
        'm',
        undefined,
        { system: MEDIA_SYSTEM_PROMPT, history: [{ role: 'user', content: 'How long until coco is finished?' }, { role: 'assistant', content: 'Coco is at 37.8%.' }] },
      );
      expect(run).toHaveBeenCalledTimes(1);
      expect(out.toolCalls).toEqual([{ name: 'list_queue', ok: true }]);
      expect(out.answer).toContain('ETA 45m');
      expect((seen[0]!.messages as unknown[]).length).toBe(3);
    });
  }
});

describe('the media prompt', () => {
  it('sends ETA, follow-up and latest-download questions to list_queue and never says it cannot check', () => {
    expect(MEDIA_SYSTEM_PROMPT).toContain('call list_queue');
    expect(MEDIA_SYSTEM_PROMPT).toContain("how long until it is downloaded");
    expect(MEDIA_SYSTEM_PROMPT).toContain('refers to the title from the earlier turns');
    expect(MEDIA_SYSTEM_PROMPT).toContain('Never say you cannot check download times');
    expect(MEDIA_SYSTEM_PROMPT).toContain('latest finished downloads');
  });

  it('still says no tool lists library additions, and labels finished downloads as downloads', () => {
    expect(MEDIA_SYSTEM_PROMPT).toContain('No tool lists titles added to the Plex library');
    expect(MEDIA_SYSTEM_PROMPT).toContain('downloads, not library additions');
  });

  it('describes list_queue with ETA and latest finished downloads', () => {
    const q = mtraceTools({ baseUrl: 'http://x', token: 't'.repeat(40) }).find((t) => t.name === 'list_queue');
    expect(q?.description).toContain('ETA');
    expect(q?.description).toContain('latest finished downloads');
  });

  it('tells the model to state only what a tool returned', () => {
    expect(MEDIA_SYSTEM_PROMPT).toContain('State only what a tool returned.');
  });
});

describe('POST /v1/media/ask', () => {
  const lab: LabTool = { name: 'pve_guests', description: 'd', input: z.object({}), run: async () => ({ source: 's', data: {} }) };
  const media: LabTool = { name: 'list_queue', description: 'd', input: z.object({}), run: async () => ({ source: 's', data: {} }) };
  const post = (body: unknown, token = ASK, path = '/v1/media/ask') =>
    new Request(`http://127.0.0.1:3016${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const make = (over: Partial<Parameters<typeof createLabHandler>[0]> = {}, seen: Array<Record<string, unknown>> = []) =>
    createLabHandler({
      askToken: ASK,
      tools: new Map([[lab.name, lab]]),
      mediaTools: new Map([[media.name, media]]),
      callModel: scripted([final('The queue is empty.')], seen),
      model: 'm',
      checks: { model: async () => 'up' },
      ...over,
    });

  it('answers a media question with the media tools and the history', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const res = await make({}, seen)(post({ question: 'what is in the queue', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { answer: string }).answer).toBe('The queue is empty.');
    const names = (seen[0]!.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(['list_queue']);
    expect((seen[0]!.messages as unknown[]).length).toBe(3);
  });

  it('answers 404 when no media tools are configured, never an answer from the lab tools', async () => {
    const res = await make({ mediaTools: undefined })(post({ question: 'what is in the queue' }));
    expect(res.status).toBe(404);
  });

  it.each([
    ['a wrong bearer', () => post({ question: 'hello' }, 'b'.repeat(40)), 401],
    ['an unknown key', () => post({ question: 'hello', extra: 1 }), 400],
    ['a bad history role', () => post({ question: 'hello', history: [{ role: 'system', content: 'x' }] }), 400],
    ['too much history', () => post({ question: 'hello', history: Array.from({ length: 13 }, () => ({ role: 'user', content: 'x' })) }), 400],
    ['a GET', () => new Request('http://127.0.0.1:3016/v1/media/ask', { method: 'GET' }), 405],
  ])('refuses %s', async (_n, req, status) => {
    expect((await make()(req())).status).toBe(status);
  });

  it('runs one question at a time across /v1/ask and /v1/media/ask', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: CallModel = async () => {
      await gate;
      return final('late');
    };
    const h = make({ callModel: slow });
    const first = h(post({ question: 'first one' }));
    await Promise.resolve();
    const second = await h(post({ question: 'second one' }, ASK, '/v1/ask'));
    expect(second.status).toBe(429);
    release();
    expect((await first).status).toBe(200);
  });
});

describe('settings', () => {
  const KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n';
  const env = {
    LAB_ASK_TOKEN: ASK, LAB_PVE_URL: 'https://192.168.50.10:8006', LAB_PVE_TOKEN_ID: 'lab-agent@pve!audit', LAB_PVE_TOKEN_SECRET: 'secret-value-123',
    LAB_VAULT_CLONE: '/v', LAB_IAC_CLONE: '/i', LAB_MEDIA_IAC_CLONE: '/m', LAB_GITHUB_APP_ID: '1', LAB_GITHUB_APP_INSTALLATION_ID: '2',
    LAB_VAULT_TOKEN: 'hvs.' + 'v'.repeat(24), LAB_NOTIFY_TOKEN: 'n'.repeat(40),
  };
  const read = (p: string) => (p.endsWith('.pem') && p.includes('github') ? KEY : '-----BEGIN CERTIFICATE-----\nM\n-----END CERTIFICATE-----\n');

  it('offers mtrace only with a token, and rejects a short one', () => {
    expect(loadLabConfig(env, read).mtrace).toBeNull();
    expect(loadLabConfig({ ...env, LAB_MTRACE_TOKEN: 'm'.repeat(40) }, read).mtrace).toEqual({ baseUrl: 'http://192.168.50.237:8237', token: 'm'.repeat(40) });
    expect(() => loadLabConfig({ ...env, LAB_MTRACE_TOKEN: 'short' }, read)).toThrow('LAB_MTRACE_TOKEN');
  });
});
