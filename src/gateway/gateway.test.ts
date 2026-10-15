/**
 * The Anthropic API gateway (PET-617): settings, pricing, ledger and route.
 *
 * Every route test injects a fake fetch, so no test can reach the real API or spend a
 * cent. The ledger is real SQLite, in memory or in a temp file.
 */
import { describe, it, expect, vi, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../server/index.js';
import { parseGatewaySettings, type GatewayEnv } from './config.js';
import { Ledger, monthOf } from './ledger.js';
import { costNanoUsd, priceFor, PRICES } from './pricing.js';
import { createGateway, MAX_IN_FLIGHT } from './route.js';

const PM_TOKEN = 'pm-agent-token-0123456789abcdefghijklmnopqrstuv';
const MAP_TOKEN = 'lab-map-token-0123456789abcdefghijklmnopqrstuvw';
const API_KEY = 'sk-ant-test-key';

const CALLERS = {
  'pm-agent': { token: PM_TOKEN, monthlyCapUsd: 15, models: ['claude-haiku-4-5'] },
  'lab-map': { token: MAP_TOKEN, monthlyCapUsd: 30, models: ['claude-haiku-4-5', 'claude-sonnet-5-5'] },
};

const env = (over: Partial<GatewayEnv> = {}): GatewayEnv => ({
  apiKey: API_KEY,
  callersJson: JSON.stringify(CALLERS),
  ledgerPath: '/var/lib/pete-bot/llm-ledger.sqlite',
  otherTokens: ['test-alert-token', 'test-notify-token'],
  ...over,
});

// ── settings ─────────────────────────────────────────────────────────────────

describe('parseGatewaySettings', () => {
  it('is off when no key is set, whatever else is', () => {
    expect(parseGatewaySettings(env({ apiKey: '', callersJson: 'not json' }))).toEqual({ state: 'off' });
    expect(parseGatewaySettings(env({ apiKey: '   ' }))).toEqual({ state: 'off' });
  });

  it('is on with each caller, its cap in nano-dollars, and its models', () => {
    const s = parseGatewaySettings(env());
    expect(s.state).toBe('on');
    if (s.state !== 'on') return;
    expect(s.callers.map((c) => [c.name, c.capNanoUsd])).toEqual([
      ['pm-agent', 15e9],
      ['lab-map', 30e9],
    ]);
    expect([...s.callers[1]!.models]).toEqual(['claude-haiku-4-5', 'claude-sonnet-5-5']);
  });

  const withCaller = (c: object) => env({ callersJson: JSON.stringify({ 'pm-agent': c }) });
  const good = CALLERS['pm-agent'];

  it.each([
    ['an empty ledger path', env({ ledgerPath: ' ' }), 'LLM_LEDGER_PATH'],
    ['an in-memory ledger', env({ ledgerPath: ':memory:' }), 'in-memory'],
    ['an in-memory ledger URI', env({ ledgerPath: 'file::memory:?cache=shared' }), 'in-memory'],
    ['a memory-mode ledger URI', env({ ledgerPath: 'file:ledger.sqlite?mode=memory' }), 'in-memory'],
    ['callers that are not JSON', env({ callersJson: '{pm-agent' }), 'not valid JSON'],
    ['no callers set at all', env({ callersJson: '' }), 'not valid JSON'],
    ['no callers', env({ callersJson: '{}' }), 'names no caller'],
    ['a bad caller name', env({ callersJson: JSON.stringify({ 'PM Agent': good }) }), 'caller name'],
    ['a short token', withCaller({ ...good, token: 'short' }), 'token'],
    ['a token with whitespace', withCaller({ ...good, token: `${PM_TOKEN} x` }), 'token'],
    ['a missing cap', withCaller({ token: PM_TOKEN, models: good.models }), 'monthlyCapUsd'],
    ['a zero cap', withCaller({ ...good, monthlyCapUsd: 0 }), 'monthlyCapUsd'],
    ['a fractional cap', withCaller({ ...good, monthlyCapUsd: 1.5 }), 'monthlyCapUsd'],
    ['a cap past $1000', withCaller({ ...good, monthlyCapUsd: 1001 }), 'monthlyCapUsd'],
    ['no models', withCaller({ ...good, models: [] }), 'models'],
    ['a model with no price', withCaller({ ...good, models: ['claude-fable-5-1'] }), 'price table'],
    ['an unknown key', withCaller({ ...good, admin: true }), 'admin'],
    [
      'two callers sharing a token',
      env({ callersJson: JSON.stringify({ a1: good, b1: good }) }),
      'shared',
    ],
  ])('is misconfigured with %s', (_name, e, fragment) => {
    const s = parseGatewaySettings(e);
    expect(s.state).toBe('misconfigured');
    if (s.state === 'misconfigured') expect(s.reason).toContain(fragment);
  });

  it('is misconfigured when a caller reuses another route’s token', () => {
    const notify = 'n'.repeat(40);
    const s = parseGatewaySettings({
      ...env({ callersJson: JSON.stringify({ 'pm-agent': { ...good, token: notify } }) }),
      otherTokens: ['test-alert-token', notify],
    });
    expect(s).toMatchObject({ state: 'misconfigured', reason: expect.stringContaining('shared') });
  });

  it('never puts a token in the reason', () => {
    const bad = JSON.stringify({ 'pm-agent': { ...good, monthlyCapUsd: -1 }, 'lab-map': CALLERS['lab-map'] });
    const s = parseGatewaySettings(env({ callersJson: bad }));
    expect(s.state).toBe('misconfigured');
    expect(JSON.stringify(s)).not.toContain(PM_TOKEN);
    expect(JSON.stringify(s)).not.toContain(MAP_TOKEN);
  });
});

// ── pricing ──────────────────────────────────────────────────────────────────

describe('pricing', () => {
  const haiku = PRICES['claude-haiku-4-5']!;

  it('prices Haiku 4.5 at $1 in, $5 out, $0.10 cache read, $1.25 and $2 cache write', () => {
    expect(haiku).toEqual({ input: 1000, output: 5000, cacheRead: 100, cacheWrite5m: 1250, cacheWrite1h: 2000 });
  });

  // Opus 5.5 and Sonnet 5.5 read their cache at 0.05x input, not 0.1x.
  it('prices Sonnet 5.5 at $2 in, $10 out, $0.10 cache read, $2.50 and $4 cache write', () => {
    expect(PRICES['claude-sonnet-5-5']).toEqual({ input: 2000, output: 10000, cacheRead: 100, cacheWrite5m: 2500, cacheWrite1h: 4000 });
  });

  it('prices Opus 5.5 at $4 in, $20 out, $0.20 cache read, $5 and $8 cache write', () => {
    expect(PRICES['claude-opus-5-5']).toEqual({ input: 4000, output: 20000, cacheRead: 200, cacheWrite5m: 5000, cacheWrite1h: 8000 });
  });

  it('prices a Sonnet 5.5 cache read at a tenth of a micro-dollar per token', () => {
    expect(costNanoUsd(PRICES['claude-sonnet-5-5']!, { cache_read_input_tokens: 1_000_000 })).toBe(100_000_000);
  });

  it('prices a dated snapshot as its alias, and refuses a model it does not know', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toBe(haiku);
    expect(priceFor('claude-haiku-4-5')).toBe(haiku);
    expect(priceFor('claude-fable-5-1')).toBeUndefined();
    expect(priceFor('toString')).toBeUndefined();
  });

  it('adds every meter', () => {
    // 1M in ($1) + 100k out ($0.50) + 1M cache read ($0.10) + 100k 5m write ($0.125)
    // + 100k 1h write ($0.20) + 2 searches ($0.02) = $1.945
    const cost = costNanoUsd(haiku, {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 200_000,
      cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 100_000 },
      server_tool_use: { web_search_requests: 2 },
    });
    expect(cost).toBe(1_945_000_000);
  });

  it('prices a cache write with no TTL split at the 1-hour rate, so it never undercounts', () => {
    expect(costNanoUsd(haiku, { cache_creation_input_tokens: 1000 })).toBe(2_000_000);
  });

  it('counts a missing or null meter as zero', () => {
    expect(costNanoUsd(haiku, {})).toBe(0);
    expect(costNanoUsd(haiku, { input_tokens: null, cache_creation: null })).toBe(0);
  });
});

// ── ledger ───────────────────────────────────────────────────────────────────

const entry = (caller: string, costNanoUsd: number) => ({
  caller,
  model: 'claude-haiku-4-5-20251001',
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costNanoUsd,
});

describe('Ledger', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('sums one caller in one UTC month', () => {
    const l = new Ledger(':memory:');
    const oct = new Date('2026-10-31T23:59:59Z');
    const nov = new Date('2026-11-01T00:00:00Z');
    l.record(entry('pm-agent', 100), oct);
    l.record(entry('pm-agent', 50), oct);
    l.record(entry('lab-map', 7000), oct);
    l.record(entry('pm-agent', 1), nov);
    expect(l.spentNanoUsd('pm-agent', oct)).toBe(150);
    expect(l.spentNanoUsd('lab-map', oct)).toBe(7000);
    expect(l.spentNanoUsd('pm-agent', nov)).toBe(1);
    expect(l.spentNanoUsd('nobody', oct)).toBe(0);
    expect(monthOf(oct)).toBe('2026-10');
  });

  it('keeps the spend across a restart', () => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const path = join(dir, 'llm-ledger.sqlite');
    const at = new Date('2026-10-14T13:30:00Z');
    const first = new Ledger(path);
    first.record(entry('pm-agent', 42), at);
    first.close();
    expect(new Ledger(path).spentNanoUsd('pm-agent', at)).toBe(42);
  });
});

// ── route ────────────────────────────────────────────────────────────────────

const OCT = new Date('2026-10-14T13:30:00Z');

const answer = (over: object = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-4-5-20251001',
  content: [{ type: 'text', text: 'brief' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ...over,
});

function upstream(status = 200, body: object = answer(), headers: Record<string, string> = {}) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'request-id': 'req_up_1', ...headers },
      }),
  );
}

function setup(opts: { fetch?: ReturnType<typeof upstream>; now?: Date; ledger?: Ledger } = {}) {
  const fetchFn = opts.fetch ?? upstream();
  const ledger = opts.ledger ?? new Ledger(':memory:');
  const gateway = createGateway(parseGatewaySettings(env()), {
    fetch: fetchFn as unknown as typeof fetch,
    ledger,
    now: () => opts.now ?? OCT,
  });
  const app = createApp({} as never, { gateway });
  return { app, fetchFn, ledger };
}

const body = (over: object = {}) => ({
  model: 'claude-haiku-4-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'What changed today?' }],
  ...over,
});

const post = (app: ReturnType<typeof setup>['app'], token = PM_TOKEN, path = '/v1/llm/v1/messages') =>
  request(app).post(path).set('authorization', `Bearer ${token}`);

describe('POST /v1/llm/v1/messages when the gateway is not on', () => {
  it.each([
    ['off', parseGatewaySettings(env({ apiKey: '' }))],
    ['misconfigured', parseGatewaySettings(env({ ledgerPath: '' }))],
  ])('answers 503 when %s, and forwards nothing', async (state, settings) => {
    const fetchFn = upstream();
    const gateway = createGateway(settings, { fetch: fetchFn as unknown as typeof fetch });
    const app = createApp({} as never, { gateway });
    const res = await post(app).send(body()).expect(503);
    expect(res.body.error.message).toContain(state);
    expect(fetchFn).not.toHaveBeenCalled();
    const health = await request(app).get('/health').expect(200);
    expect(health.body.llm).toBe(state);
  });
});

describe('POST /v1/llm/v1/messages auth', () => {
  it.each([
    ['no bearer', undefined],
    ['a wrong bearer', 'x'.repeat(48)],
    ['the notify bearer', 'test-notify-token'],
    ['the alert bearer', 'test-alert-token'],
    ['the Anthropic key itself', API_KEY],
  ])('refuses %s with 401', async (_name, token) => {
    const { app, fetchFn } = setup();
    const req = request(app).post('/v1/llm/v1/messages');
    if (token) req.set('authorization', `Bearer ${token}`);
    const res = await req.send(body()).expect(401);
    expect(res.body).toEqual({ type: 'error', error: { type: 'authentication_error', message: 'unknown gateway token' } });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('accepts the token as x-api-key, which the SDK sends when given apiKey', async () => {
    const { app, fetchFn } = setup();
    await request(app).post('/v1/llm/v1/messages').set('x-api-key', PM_TOKEN).send(body()).expect(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('POST /v1/llm/v1/messages payload', () => {
  it.each([
    ['no model', { model: undefined }],
    ['no max_tokens', { max_tokens: undefined }],
    ['a fractional max_tokens', { max_tokens: 1.5 }],
    ['stream: true', { stream: true }],
    // Each of these bills above the rates in pricing.ts, so the cap would undercount.
    ['speed: "fast"', { speed: 'fast' }],
    ['inference_geo', { inference_geo: 'us' }],
    ['service_tier', { service_tier: 'auto' }],
    ['a parameter it does not know', { mcp_servers: [] }],
    ['a code execution tool', { tools: [{ type: 'code_execution_20250825', name: 'code_execution' }] }],
  ])('refuses %s with 400', async (_name, over) => {
    const { app, fetchFn } = setup();
    const res = await post(app).send(body(over)).expect(400);
    expect(res.body.error.type).toBe('invalid_request_error');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ['a model it was not given', 'claude-sonnet-5-5'],
    ['a model with no price', 'claude-fable-5-1'],
  ])('refuses %s with 403', async (_name, model) => {
    const { app, fetchFn } = setup();
    const res = await post(app).send(body({ model })).expect(403);
    expect(res.body.error).toEqual({ type: 'permission_error', message: `pm-agent may not use ${model}` });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('forwards the parameters it can price, and client and web search tools', async () => {
    const { app, fetchFn } = setup();
    await post(app)
      .send(
        body({
          system: 'You write the morning brief.',
          temperature: 0.2,
          stop_sequences: ['END'],
          thinking: { type: 'adaptive' },
          output_config: { effort: 'low' },
          metadata: { user_id: 'pm-agent' },
          tool_choice: { type: 'auto' },
          tools: [
            { name: 'read_pr', description: 'Read a PR', input_schema: { type: 'object' } },
            { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
          ],
        }),
      )
      .expect(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refuses an unauthenticated body before parsing it, even one past the 8mb limit', async () => {
    const { app, fetchFn } = setup();
    const huge = JSON.stringify(body({ messages: [{ role: 'user', content: 'x'.repeat(9 * 1024 * 1024) }] }));
    // 401, not 413: the guard answered before the parser read the body.
    await request(app).post('/v1/llm/v1/messages').set('content-type', 'application/json').send(huge).expect(401);
    // With a token, the parser refuses it as the API would: a 413 the SDK does not retry.
    const tooBig = await post(app).set('content-type', 'application/json').send(huge).expect(413);
    expect(tooBig.body.error.type).toBe('request_too_large');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a body that is not JSON with a 400, not a 500 the SDK would retry', async () => {
    const { app, fetchFn } = setup();
    const res = await post(app).set('content-type', 'application/json').send('{"model":').expect(400);
    expect(res.body.error.type).toBe('invalid_request_error');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('accepts a dated snapshot of an allowed model', async () => {
    const { app } = setup();
    await post(app).send(body({ model: 'claude-haiku-4-5-20251001' })).expect(200);
  });

  it('takes a body past the 512kb every other route is held to', async () => {
    const { app, fetchFn } = setup();
    const big = 'x'.repeat(1024 * 1024);
    await post(app).send(body({ messages: [{ role: 'user', content: big }] })).expect(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('POST /v1/llm/v1/messages forwarding', () => {
  it('sends the body unchanged with the real key, and never the caller’s token', async () => {
    const { app, fetchFn } = setup();
    const sent = body({ system: 'You are the PM.', tools: [{ name: 't', input_schema: { type: 'object' } }] });
    await post(app)
      .set('anthropic-version', '2023-06-01')
      .set('anthropic-beta', 'some-beta-2026-01-01')
      .send(sent)
      .expect(200);

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-beta']).toBe('some-beta-2026-01-01');
    expect(JSON.parse(init!.body as string)).toEqual(sent);
    expect(JSON.stringify(init)).not.toContain(PM_TOKEN);
    expect(headers.authorization).toBeUndefined();
  });

  it('defaults anthropic-version when the caller sends none', async () => {
    const { app, fetchFn } = setup();
    await post(app).send(body()).expect(200);
    expect((fetchFn.mock.calls[0]![1]!.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
  });

  it('serves the shorter /v1/llm/messages path too', async () => {
    const { app } = setup();
    await post(app, PM_TOKEN, '/v1/llm/messages').send(body()).expect(200);
  });

  it('returns the API’s answer and request-id, and records its cost', async () => {
    const { app, ledger } = setup();
    const res = await post(app).send(body()).expect(200);
    expect(res.body).toEqual(answer());
    expect(res.headers['request-id']).toBe('req_up_1');
    // 1000 in at $1/MTok + 200 out at $5/MTok = $0.002
    expect(ledger.spentNanoUsd('pm-agent', OCT)).toBe(2_000_000);
    expect(ledger.spentNanoUsd('lab-map', OCT)).toBe(0);
  });

  it('passes an API error and its retry-after through, and records nothing', async () => {
    const err = { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } };
    const { app, ledger } = setup({ fetch: upstream(429, err, { 'retry-after': '7' }) });
    const res = await post(app).send(body()).expect(429);
    expect(res.body).toEqual(err);
    expect(res.headers['retry-after']).toBe('7');
    expect(ledger.spentNanoUsd('pm-agent', OCT)).toBe(0);
  });

  it('answers 502 when the API is unreachable', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { app } = setup({ fetch: fetchFn as never });
    const res = await post(app).send(body()).expect(502);
    expect(res.body.error.type).toBe('api_error');
  });

  it('answers 503 and forwards nothing when the ledger cannot be read', async () => {
    const ledger = new Ledger(':memory:');
    ledger.close();
    const { app, fetchFn } = setup({ ledger });
    await post(app).send(body()).expect(503);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('POST /v1/llm/v1/messages monthly cap', () => {
  it('refuses a caller at its cap with a 403 the SDK will not retry', async () => {
    const ledger = new Ledger(':memory:');
    ledger.record(entry('pm-agent', 15e9), OCT);
    const { app, fetchFn } = setup({ ledger });
    const res = await post(app).send(body()).expect(403);
    expect(res.body.error).toEqual({
      type: 'permission_error',
      message: 'pm-agent has spent $15.00 of its $15.00 monthly cap',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('lets one request cross the cap, then refuses the next', async () => {
    const ledger = new Ledger(':memory:');
    ledger.record(entry('pm-agent', 15e9 - 1), OCT);
    const { app, fetchFn } = setup({ ledger });
    await post(app).send(body()).expect(200);
    await post(app).send(body()).expect(403);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('holds each caller to its own cap', async () => {
    const ledger = new Ledger(':memory:');
    ledger.record(entry('pm-agent', 15e9), OCT);
    const { app } = setup({ ledger });
    await post(app, PM_TOKEN).send(body()).expect(403);
    await post(app, MAP_TOKEN).send(body()).expect(200);
  });

  it('starts each caller fresh on the 1st of the month, UTC', async () => {
    const ledger = new Ledger(':memory:');
    ledger.record(entry('pm-agent', 15e9), new Date('2026-10-31T23:59:59Z'));
    const { app } = setup({ ledger, now: new Date('2026-11-01T00:00:00Z') });
    await post(app).send(body()).expect(200);
  });
});

// ── review fixes (pete-bot#30, round 1) ──────────────────────────────────────

/** A fetch that answers only when released, so a test can hold requests open. */
function heldUpstream() {
  const releases: Array<() => void> = [];
  const fetchFn = vi.fn(
    (_url: string | URL | Request, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        releases.push(() =>
          resolve(new Response(JSON.stringify(answer()), { status: 200, headers: { 'content-type': 'application/json' } })),
        );
      }),
  );
  return { fetchFn, releaseAll: () => releases.splice(0).forEach((r) => r()) };
}

describe('POST /v1/llm/v1/messages concurrency', () => {
  it(`holds each caller to ${MAX_IN_FLIGHT} open requests with a 429 the SDK retries`, async () => {
    const { fetchFn, releaseAll } = heldUpstream();
    const { app } = setup({ fetch: fetchFn as never });
    const open = Array.from({ length: MAX_IN_FLIGHT }, () => post(app).send(body()).then((r) => r.status));
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchFn).toHaveBeenCalledTimes(MAX_IN_FLIGHT);

    const extra = await post(app).send(body()).expect(429);
    expect(extra.body.error.type).toBe('rate_limit_error');
    expect(extra.headers['retry-after']).toBe('1');
    // Another caller has its own allowance.
    const other = post(app, MAP_TOKEN).send(body()).then((r) => r.status);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchFn).toHaveBeenCalledTimes(MAX_IN_FLIGHT + 1);

    releaseAll();
    const statuses: number[] = await Promise.all([...open, other]);
    expect(statuses).toEqual(Array<number>(MAX_IN_FLIGHT + 1).fill(200));
    // The slots are free again.
    const after = post(app).send(body()).then((r) => r.status);
    await new Promise((r) => setTimeout(r, 50));
    releaseAll();
    expect(await after).toBe(200);
  });
});

describe('POST /v1/llm/v1/messages ledger failures', () => {
  it('is misconfigured, not crashed, when the ledger path cannot be opened', async () => {
    const fetchFn = upstream();
    const gateway = createGateway(parseGatewaySettings(env({ ledgerPath: '/nonexistent/dir/ledger.sqlite' })), {
      fetch: fetchFn as unknown as typeof fetch,
    });
    expect(gateway.state).toBe('misconfigured');
    const app = createApp({} as never, { gateway });
    await post(app).send(body()).expect(503);
    expect((await request(app).get('/health').expect(200)).body.llm).toBe('misconfigured');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns the answer after a failed write, then refuses every request', async () => {
    const ledger = new Ledger(':memory:');
    ledger.record = () => {
      throw new Error('disk full');
    };
    const { app, fetchFn } = setup({ ledger });
    // The tokens are spent, so the answer goes back rather than a 5xx the SDK would retry.
    await post(app).send(body()).expect(200);
    const res = await post(app, MAP_TOKEN).send(body()).expect(503);
    expect(res.body.error.message).toContain('ledger');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('POST /v1/llm/v1/messages answers with no usage', () => {
  // Nothing in a request bounds its cost, so an answer the ledger cannot price is charged
  // the rest of the caller's cap. pm-agent's cap is $15.
  const CAP = 15e9;
  const broken = () =>
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error('socket hang up'));
            },
          }),
          { status: 200 },
        ),
    );

  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('charges the rest of the cap for an answer with no usage, and refuses the next request', async () => {
    const { app, ledger, fetchFn } = setup({ fetch: upstream(200, answer({ usage: undefined })) });
    await post(app).send(body()).expect(200);
    expect(ledger.spentNanoUsd('pm-agent', OCT)).toBe(CAP);
    const res = await post(app).send(body()).expect(403);
    expect(res.body.error.message).toContain('monthly cap');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('charges only what is left when the caller has already spent some', async () => {
    const ledger = new Ledger(':memory:');
    ledger.record(entry('pm-agent', 4e9), OCT);
    const { app } = setup({ ledger, fetch: upstream(200, answer({ usage: undefined })) });
    await post(app).send(body()).expect(200);
    expect(ledger.spentNanoUsd('pm-agent', OCT)).toBe(CAP);
  });

  it('charges the rest of the cap for an answer that is not JSON', async () => {
    const fetchFn = vi.fn(async () => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const { app, ledger } = setup({ fetch: fetchFn as never });
    await post(app).send(body()).expect(200);
    expect(ledger.spentNanoUsd('pm-agent', OCT)).toBe(CAP);
  });

  it.each([
    ['no output_tokens', { input_tokens: 10 }],
    ['no input_tokens', { output_tokens: 10 }],
    ['a null meter', { input_tokens: null, output_tokens: 10 }],
    ['a string meter', { input_tokens: '10', output_tokens: 10 }],
    ['an array', []],
  ])('charges the rest of the cap for a usage with %s', async (_name, usage) => {
    const { app, ledger } = setup({ fetch: upstream(200, answer({ usage })) });
    await post(app).send(body()).expect(200);
    expect(ledger.spentNanoUsd('pm-agent', OCT)).toBe(CAP);
  });

  it('charges a caller only its own cap', async () => {
    const { app, ledger } = setup({ fetch: upstream(200, answer({ usage: undefined })) });
    await post(app).send(body()).expect(200);
    expect(ledger.spentNanoUsd('lab-map', OCT)).toBe(0);
    await post(app, MAP_TOKEN).send(body()).expect(200);
    expect(ledger.spentNanoUsd('lab-map', OCT)).toBe(30e9);
  });

  it('answers 502 and charges the rest of the cap when the answer breaks off', async () => {
    const { app, ledger } = setup({ fetch: broken() as never });
    await post(app).send(body()).expect(502);
    expect(ledger.spentNanoUsd('pm-agent', OCT)).toBe(CAP);
  });

  // The case the request body cannot bound: an image by URL bills input tokens for pixels
  // the gateway never sees, so no count of the body's characters is an upper bound.
  it('refuses spend after an image request whose answer broke off, across a restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const path = join(dir, 'llm-ledger.sqlite');
    const image = body({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: 'https://example.com/huge.png' } },
            { type: 'text', text: 'Describe it.' },
          ],
        },
      ],
    });

    const first = setup({ ledger: new Ledger(path), fetch: broken() as never });
    await post(first.app).send(image).expect(502);
    expect(first.ledger.spentNanoUsd('pm-agent', OCT)).toBe(CAP);
    first.ledger.close();

    const fetchFn = upstream();
    const second = setup({ ledger: new Ledger(path), fetch: fetchFn });
    const res = await post(second.app).send(image).expect(403);
    expect(res.body.error.message).toContain('monthly cap');
    expect(fetchFn).not.toHaveBeenCalled();
    second.ledger.close();
  });

  it('lifts the refusal when the month turns over', async () => {
    const ledger = new Ledger(':memory:');
    const { app } = setup({ ledger, fetch: upstream(200, answer({ usage: undefined })) });
    await post(app).send(body()).expect(200);
    const nov = setup({ ledger, now: new Date('2026-11-01T00:00:00Z') });
    await post(nov.app).send(body()).expect(200);
  });
});
