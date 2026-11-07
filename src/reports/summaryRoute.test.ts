import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardApp } from './dashboard.js';
import { WeekStore, type WeekRecord } from './weekly.js';

const WEEK = '2026-11-02';
const rec = (): WeekRecord => ({
  week: WEEK,
  generatedAt: '2026-11-08T03:00:00Z',
  total: 2,
  byRepo: { a: 1, b: 1 },
  byAuthor: { Pedro: 2 },
  openNow: 0,
  merged: [
    { repo: 'a', number: 1, title: 'PET-1 one', url: 'https://github.com/o/a/pull/1', author: 'Pedro', mergedAt: '2026-11-03T12:00:00Z', petKeys: [1] },
    { repo: 'b', number: 2, title: 'PET-2 two', url: 'https://github.com/o/b/pull/2', author: 'Pedro', mergedAt: '2026-11-04T12:00:00Z', petKeys: [2] },
  ],
  coverage: { reposRead: 2, reposTotal: 2, unread: [], floorRepos: [] },
  summary: { source: 'none', text: '', reason: 'ollama down' },
});

describe('POST /api/weeks/:week/summary', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  async function post(body: unknown, opts: { summarize?: (n: number) => Promise<string>; week?: string; type?: string | null; ok?: boolean } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'sum-'));
    const store = new WeekStore(dir);
    store.save(rec());
    const seen: number[] = [];
    const app = createDashboardApp({
      store,
      summarize: opts.summarize ? async (prs) => (seen.push(prs.length), opts.summarize!(prs.length)) : undefined,
      verify: async () => (opts.ok === false ? { ok: false, reason: 'x' } : { ok: true, email: 'p@x.dev' }),
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const headers: Record<string, string> = opts.type === null ? {} : { 'Content-Type': opts.type ?? 'application/json' };
      const res = await fetch(`http://127.0.0.1:${port}/api/weeks/${opts.week ?? WEEK}/summary`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as { error?: string }, seen, saved: store.get(WEEK) };
    } finally {
      server.close();
    }
  }
  it('refuses without a verified JWT', async () => {
    expect((await post({}, { summarize: async () => 'x', ok: false })).status).toBe(403);
  });
  it('refuses a body that is not JSON, so a cross-site form cannot trigger it', async () => {
    expect((await post({}, { summarize: async () => 'x', type: 'text/plain' })).status).toBe(415);
  });
  it('writes the whole-week summary and keeps it', async () => {
    const r = await post({}, { summarize: async (n) => `sum of ${n}` });
    expect(r.status).toBe(200);
    expect(r.saved?.summary).toEqual({ source: 'ollama', model: 'qwen3:8b', text: 'sum of 2' });
  });
  it('writes one repo under repoSummaries and leaves the week summary', async () => {
    const r = await post({ repo: 'a' }, { summarize: async (n) => `sum of ${n}` });
    expect(r.status).toBe(200);
    expect(r.seen).toEqual([1]);
    expect(r.saved?.repoSummaries?.a?.text).toBe('sum of 1');
    expect(r.saved?.summary.source).toBe('none');
  });
  it('rejects a repo not in the week and an unknown week', async () => {
    expect((await post({ repo: 'zzz' }, { summarize: async () => 'x' })).status).toBe(400);
    expect((await post({}, { summarize: async () => 'x', week: '2026-01-05' })).status).toBe(404);
  });
  it('reports a failed model call and stores nothing', async () => {
    const r = await post({}, { summarize: async () => { throw new Error('ollama 500'); } });
    expect(r.status).toBe(502);
    expect(r.json.error).toContain('ollama 500');
    expect(r.saved?.summary.source).toBe('none');
  });
  it('returns a stored summary without calling the model again, unless regenerate is set', async () => {
    let calls = 0;
    const count = async (n: number) => (calls++, `sum ${n}`);
    // Seed a stored repo summary by asking twice on one app.
    dir = mkdtempSync(join(tmpdir(), 'sum2-'));
    const store = new WeekStore(dir);
    store.save(rec());
    const app = createDashboardApp({ store, summarize: async (p) => count(p.length), verify: async () => ({ ok: true, email: 'p@x.dev' }) });
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/weeks/${WEEK}/summary`;
      const ask = async (body: object) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<{ cached?: boolean }>;
      expect((await ask({})).cached).toBe(false);
      expect((await ask({})).cached).toBe(true);
      expect((await ask({ repo: 'a' })).cached).toBe(false);
      expect((await ask({ repo: 'a' })).cached).toBe(true);
      expect(calls).toBe(2);
      expect((await ask({ regenerate: true })).cached).toBe(false);
      expect(calls).toBe(3);
    } finally {
      server.close();
    }
  });
  it('answers a record that lacks fields instead of hanging, and regenerates a repo summary that covers fewer PRs', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sum3-'));
    const store = new WeekStore(dir);
    store.save({ week: WEEK, generatedAt: 'x', total: 1 } as unknown as WeekRecord);
    const old = rec();
    old.week = '2026-10-26';
    old.repoSummaries = { a: { model: 'm', text: 'old', at: 'x', prs: 5 } };
    store.save(old);
    let calls = 0;
    const app = createDashboardApp({ store, summarize: async () => (calls++, 'new'), verify: async () => ({ ok: true, email: 'p@x.dev' }) });
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/weeks`;
      const ask = (week: string, body: object) => fetch(`${base}/${week}/summary`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect((await ask(WEEK, {})).status).toBe(400);
      const r = await ask('2026-10-26', { repo: 'a' });
      expect(r.status).toBe(200);
      expect(calls).toBe(1);
      expect(store.get('2026-10-26')?.repoSummaries?.a?.text).toBe('new');
    } finally {
      server.close();
    }
  });
  it('is 404 when no summarizer is wired', async () => {
    expect((await post({})).status).toBe(404);
  });
});
