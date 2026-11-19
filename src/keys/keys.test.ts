/** The Secrets screen's API: the parser for keys.yml's list, the client's requests, and the routes' gates. GitHub is faked. */
import { afterEach, describe, expect, it, vi } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKeysClient, newRequestId, REQUEST_ID_RE, type KeysClient } from './client.js';
import { parseKeyList } from './list.js';
import { createDashboardApp } from '../reports/dashboard.js';
import { WeekStore } from '../reports/weekly.js';
import { KeysCache } from './cache.js';

const LOG = [
  '2026-11-18T10:00:00.0000000Z action=list name=none pet=none sha=abc actor=x',
  '2026-11-18T10:00:05.0000000Z muse: owner pedro, version 3, client id ca14c1dd.access, expires 2027-02-10T00:00:00Z, 84 days left; in callers.yml',
  '2026-11-18T10:00:05.0000000Z batsy: owner sonia, version 1, client id d620c3dd.access, expires 2026-12-01T00:00:00Z, 13 days left (renew soon); in callers.yml',
  '2026-11-18T10:00:05.0000000Z old: owner pedro, version 2, client id zz.access, expires 2026-11-01T00:00:00Z, EXPIRED; NOT in callers.yml (sync revokes it)',
  '2026-11-18T10:00:05.0000000Z staging: no token (sync creates it)',
  '2026-11-18T10:00:06.0000000Z keys list: read 3 agents in callers.yml and 3 Vault entries; 1 expired',
].join('\n');

describe('parseKeyList', () => {
  it('reads each row and the summary, and drops the client id', () => {
    const l = parseKeyList(LOG)!;
    expect(l.rows.map((r) => r.name)).toEqual(['muse', 'batsy', 'old', 'staging']);
    expect(l.rows[0]).toMatchObject({ owner: 'pedro', version: '3', daysLeft: 84, expired: false, renewSoon: false, inCallers: true, hasToken: true });
    expect(l.rows[1]).toMatchObject({ renewSoon: true, daysLeft: 13 });
    expect(l.rows[2]).toMatchObject({ expired: true, inCallers: false });
    expect(l.rows[3]).toMatchObject({ hasToken: false });
    expect(l.read).toBe('keys list: read 3 agents in callers.yml and 3 Vault entries; 1 expired');
    expect(l.unparsed).toBe(0);
    expect(JSON.stringify(l)).not.toContain('ca14c1dd');
  });
  it('returns nothing when the summary line is missing, and counts a row it cannot read', () => {
    expect(parseKeyList('muse: owner pedro')).toBeUndefined();
    expect(parseKeyList('muse: something odd\nkeys list: read 1 agents in callers.yml and 1 Vault entries; 0 expired')!.unparsed).toBe(1);
  });
});

describe('client', () => {
  const cfg = { token: 't', repo: 'o/r', workflow: 'keys.yml' };
  it('dispatches on main with the fixed inputs and refuses a bad name or action', async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const c = createKeysClient(cfg, f as unknown as typeof fetch);
    await c.dispatch('rotate', 'muse', 'pb-abc-123456');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/o/r/actions/workflows/keys.yml/dispatches');
    expect(JSON.parse(init.body)).toEqual({ ref: 'main', inputs: { action: 'rotate', name: 'muse', pet: '', request_id: 'pb-abc-123456' } });
    await expect(c.dispatch('rotate', 'Bad Name', 'pb-abc-123456')).rejects.toThrow('agree');
    await expect(c.dispatch('sync', 'muse', 'pb-abc-123456')).rejects.toThrow('agree');
    await expect(c.dispatch('nuke' as never, undefined, 'pb-abc-123456')).rejects.toThrow('unknown');
    await expect(c.dispatch('list', undefined, 'x; rm')).rejects.toThrow('request id');
    expect(f.mock.calls.length).toBe(1);
  });
  it('matches a run by the request id in its title', async () => {
    const f = vi.fn(async () => Response.json({ workflow_runs: [{ id: 1, html_url: 'u1', status: 'queued', conclusion: null, display_title: 'keys list [pb-zzz-000000]' }, { id: 2, html_url: 'u2', status: 'waiting', conclusion: null, display_title: 'keys sync [pb-abc-123456]' }] }));
    const c = createKeysClient(cfg, f as unknown as typeof fetch);
    expect((await c.findRun('pb-abc-123456'))?.id).toBe(2);
    expect(await c.findRun('pb-nope-000000')).toBeUndefined();
    expect(REQUEST_ID_RE.test(newRequestId())).toBe(true);
  });
  it('does not send the token to the log blob', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      if (url.endsWith('/jobs')) return Response.json({ jobs: [{ id: 9 }] });
      if (url.endsWith('/logs')) return new Response(null, { status: 302, headers: { location: 'https://blob.example/x' } });
      return new Response('log text');
    });
    expect(await createKeysClient(cfg, f as unknown as typeof fetch).jobLog(5)).toBe('log text');
    expect(JSON.stringify(calls[2]![1].headers ?? {})).not.toContain('Bearer');
  });
});

describe('routes', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const fake = (over: Partial<KeysClient> = {}): KeysClient => ({
    dispatch: vi.fn(async () => {}),
    findRun: vi.fn(async () => ({ id: 7, url: 'https://github.com/o/r/actions/runs/7', status: 'waiting', conclusion: null })),
    jobLog: vi.fn(async () => LOG),
    ...over,
  });
  async function call(client: KeysClient, opts: { email?: string; admins?: string[]; keys?: boolean }, fn: (base: string) => Promise<void>) {
    dir = mkdtempSync(join(tmpdir(), 'keys-'));
    const app = createDashboardApp({
      store: new WeekStore(dir),
      services: async () => [],
      verify: async () => ({ ok: true, email: opts.email ?? 'pedro@x.dev' }),
      keys: opts.keys === false ? undefined : { client, admins: opts.admins ?? ['pedro@x.dev'], findTimeoutMs: 0, sleep: async () => {} },
    });
    const server = app.listen(0);
    try {
      await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    } finally {
      server.close();
    }
  }
  const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/keys/runs`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('answers 404 when the keys API is not configured', async () => {
    await call(fake(), { keys: false }, async (b) => expect((await post(b, { action: 'list' })).status).toBe(404));
  });
  it('refuses a signed-in person who is not an admin, and never calls GitHub', async () => {
    const c = fake();
    await call(c, { email: 'sonia@x.dev' }, async (b) => {
      expect((await post(b, { action: 'list' })).status).toBe(403);
      expect((await fetch(`${b}/api/keys/runs/pb-abc-123456`)).status).toBe(403);
    });
    expect(c.dispatch).not.toHaveBeenCalled();
  });
  it('starts a run for an admin and says the run was not found yet when it has not appeared', async () => {
    const c = fake({ findRun: vi.fn(async () => undefined) });
    await call(c, {}, async (b) => {
      const res = await post(b, { action: 'rotate', name: 'muse' });
      expect(res.status).toBe(202);
      const j = (await res.json()) as { requestId: string; run: unknown };
      expect(REQUEST_ID_RE.test(j.requestId)).toBe(true);
      expect(j.run).toBeNull();
    });
    expect(c.dispatch).toHaveBeenCalledWith('rotate', 'muse', expect.stringMatching(/^pb-/));
  });
  it('validates the body', async () => {
    const c = fake();
    await call(c, {}, async (b) => {
      expect((await post(b, { action: 'delete' })).status).toBe(400);
      expect((await post(b, { action: 'rotate' })).status).toBe(400);
      expect((await post(b, { action: 'rotate', name: '../x' })).status).toBe(400);
      expect((await post(b, { action: 'sync', name: 'muse' })).status).toBe(400);
      expect((await fetch(`${b}/api/keys/runs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"action":"list"}' })).status).toBe(415);
      expect((await fetch(`${b}/api/keys/runs/not-an-id`)).status).toBe(400);
    });
    expect(c.dispatch).not.toHaveBeenCalled();
  });
  it('refuses another origin', async () => {
    const c = fake();
    await call(c, {}, async (b) => {
      expect((await post(b, { action: 'sync' }, { origin: 'https://staging-dash.pdlab.dev' })).status).toBe(403);
      expect((await post(b, { action: 'sync' }, { origin: b })).status).toBe(202);
    });
    expect((c.dispatch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
  it('limits writes: a second one at once, then six in an hour', async () => {
    let t = 1_000_000;
    dir = mkdtempSync(join(tmpdir(), 'keys-'));
    const app = createDashboardApp({ store: new WeekStore(dir), services: async () => [], verify: async () => ({ ok: true, email: 'pedro@x.dev' }), keys: { client: fake(), admins: ['pedro@x.dev'], findTimeoutMs: 0, now: () => t, sleep: async () => {} } });
    const server = app.listen(0);
    try {
      const b = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      expect((await post(b, { action: 'sync' })).status).toBe(202);
      expect((await post(b, { action: 'sync' })).status).toBe(429);
      for (let i = 0; i < 5; i++) {
        t += 10_000;
        expect((await post(b, { action: 'renew', name: 'muse' })).status).toBe(202);
      }
      t += 10_000;
      expect((await post(b, { action: 'renew', name: 'muse' })).status).toBe(429);
      expect((await post(b, { action: 'list' })).status).toBe(202); // a list has its own limit
      expect((await post(b, { action: 'list' })).status).toBe(429);
    } finally {
      server.close();
    }
  });
  it('reports a finished list with no rows as failed, and a finished sync as done', async () => {
    const run = vi.fn(async () => ({ id: 7, url: 'u', status: 'completed', conclusion: 'success' }));
    await call(fake({ findRun: run, jobLog: vi.fn(async () => 'nothing useful') }), {}, async (b) => {
      const l = (await (await fetch(`${b}/api/keys/runs/pb-abc-123456?action=list`)).json()) as { state: string; logError?: string };
      expect(l.state).toBe('failed');
      expect(l.logError).toContain('no key list');
      const s = (await (await fetch(`${b}/api/keys/runs/pb-abc-123456?action=sync`)).json()) as { state: string };
      expect(s.state).toBe('done');
      expect((await fetch(`${b}/api/keys/runs/pb-abc-123456?action=nuke`)).status).toBe(400);
    });
  });
  it('maps the run state, and returns the parsed list only for a finished run', async () => {
    const states: Array<[string, string, string | null, string]> = [['queued', 'queued', null, 'queued'], ['in_progress', 'x', null, 'running'], ['waiting', 'x', null, 'waiting_tap'], ['completed', 'x', 'failure', 'failed'], ['completed', 'x', 'success', 'done']];
    for (const [status, , conclusion, want] of states) {
      await call(fake({ findRun: vi.fn(async () => ({ id: 7, url: 'u', status, conclusion })) }), {}, async (b) => {
        const j = (await (await fetch(`${b}/api/keys/runs/pb-abc-123456?action=list`)).json()) as { state: string; list?: { rows: unknown[] } };
        expect(j.state).toBe(want);
        expect(!!j.list).toBe(want === 'done');
      });
    }
    await call(fake({ findRun: vi.fn(async () => undefined) }), {}, async (b) => expect(((await (await fetch(`${b}/api/keys/runs/pb-abc-123456`)).json()) as { state: string }).state).toBe('not_found'));
  });
  it('keeps a finished list for the feed, and the feed has no keys section before any list was read', async () => {
    dir = mkdtempSync(join(tmpdir(), 'keys-'));
    const cache = new KeysCache();
    const client = fake({ findRun: vi.fn(async () => ({ id: 7, url: 'u', status: 'completed', conclusion: 'success' })) });
    const app = createDashboardApp({ store: new WeekStore(dir), services: async () => [], keysCache: cache, verify: async () => ({ ok: true, email: 'pedro@x.dev' }), keys: { client, admins: ['pedro@x.dev'], cache, findTimeoutMs: 0, sleep: async () => {} } });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      expect(((await (await fetch(`${base}/api/dashboard`)).json()) as { keys?: unknown }).keys).toBeUndefined();
      await fetch(`${base}/api/keys/runs/pb-abc-123456?action=list`);
      // A signed-in person who is not a keys admin gets the feed without the list.
      const other = createDashboardApp({ store: new WeekStore(dir), services: async () => [], keysCache: cache, verify: async () => ({ ok: true, email: 'sonia@x.dev' }), keys: { client, admins: ['pedro@x.dev'], cache } }).listen(0);
      try {
        expect('keys' in ((await (await fetch(`http://127.0.0.1:${(other.address() as { port: number }).port}/api/dashboard`)).json()) as object)).toBe(false);
      } finally {
        other.close();
      }
      const feed = (await (await fetch(`${base}/api/dashboard`)).json()) as { keys?: { rows: { name: string }[] } };
      expect(feed.keys?.rows.map((r) => r.name)).toEqual(['muse', 'batsy', 'old', 'staging']);
      expect(JSON.stringify(feed)).not.toContain('ca14c1dd');
    } finally {
      server.close();
    }
  });
});
