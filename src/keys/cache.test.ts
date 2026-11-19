/** The key list cache and its timer: what the feed carries for staging. GitHub is faked, so nothing leaves this process. */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeysCache } from './cache.js';
import { refreshKeyList } from './refresh.js';
import { parseKeyList } from './list.js';
import { buildDashboardFeed } from '../reports/feed.js';
import type { KeysClient } from './client.js';

const LOG = [
  '2026-11-18T10:00:05.0000000Z muse: owner pedro, version 3, client id ca14c1dd.access, expires 2027-02-10T00:00:00Z, 84 days left; in callers.yml',
  '2026-11-18T10:00:06.0000000Z keys list: read 1 agents in callers.yml and 1 Vault entries; 0 expired',
].join('\n');
const LIST = parseKeyList(LOG)!;
const NOW = Date.parse('2026-11-18T12:00:00Z');
const noSleep = () => Promise.resolve();

let dir = '';
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe('KeysCache', () => {
  it('keeps a list across a restart', () => {
    dir = mkdtempSync(join(tmpdir(), 'kc-'));
    new KeysCache(dir).set(LIST, new Date(NOW));
    const s = new KeysCache(dir).get()!;
    expect(s.at).toBe(new Date(NOW).toISOString());
    expect(s.list.rows.map((r) => r.name)).toEqual(['muse']);
  });
  it('reads a missing or broken file as never read, not as an empty list', () => {
    dir = mkdtempSync(join(tmpdir(), 'kc-'));
    expect(new KeysCache(dir).get()).toBeNull();
    writeFileSync(join(dir, 'keys-list.json'), '{not json');
    expect(new KeysCache(dir).get()).toBeNull();
    writeFileSync(join(dir, 'keys-list.json'), JSON.stringify({ at: 'never', list: { rows: [] } }));
    expect(new KeysCache(dir).get()).toBeNull();
  });
  it('still serves this process when the file cannot be written', () => {
    const c = new KeysCache('/proc/nope/keys');
    expect(c.set(LIST, new Date(NOW))).toBe(false);
    expect(c.get()?.list.rows).toHaveLength(1);
  });
});

function fakeClient(run: { id: number; url: string; status: string; conclusion: string | null } | undefined, log = LOG) {
  const calls: string[] = [];
  const client = {
    dispatch: async (a: string) => void calls.push(`dispatch ${a}`),
    findRun: async () => run,
    jobLog: async () => log,
  } as unknown as KeysClient;
  return { client, calls };
}

describe('refreshKeyList', () => {
  it('stores the parsed list of a finished run', async () => {
    const cache = new KeysCache();
    const { client, calls } = fakeClient({ id: 1, url: 'u', status: 'completed', conclusion: 'success' });
    expect(await refreshKeyList({ client, cache, now: () => NOW, sleep: noSleep })).toEqual({ ok: true, rows: 1 });
    expect(calls).toEqual(['dispatch list']);
    expect(cache.get()?.list.rows[0]?.name).toBe('muse');
  });
  it.each([
    ['a run that never appears', undefined, LOG, 'never appeared'],
    ['a failed run', { id: 1, url: 'u', status: 'completed', conclusion: 'failure' }, LOG, 'ended failure'],
    ['a log with no key list', { id: 1, url: 'u', status: 'completed', conclusion: 'success' }, 'nothing here', 'no key list'],
    ['a list with no rows', { id: 1, url: 'u', status: 'completed', conclusion: 'success' }, 'keys list: read 0 agents in callers.yml and 0 Vault entries; 0 expired', 'listed no keys'],
  ])('keeps the last good list after %s, and says why', async (_n, run, log, why) => {
    const cache = new KeysCache();
    cache.set(LIST, new Date(NOW - 1000));
    let t = NOW;
    const { client } = fakeClient(run as never, log);
    const r = await refreshKeyList({ client, cache, now: () => (t += 30_000), sleep: noSleep });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain(why);
    expect(cache.get()?.at).toBe(new Date(NOW - 1000).toISOString());
  });
  it('gives up on a run that never finishes', async () => {
    const cache = new KeysCache();
    let t = NOW;
    const { client } = fakeClient({ id: 1, url: 'u', status: 'in_progress', conclusion: null });
    const r = await refreshKeyList({ client, cache, now: () => (t += 60_000), sleep: noSleep });
    expect(r).toEqual({ ok: false, reason: 'the run did not finish in time' });
    expect(cache.get()).toBeNull();
  });
});

describe('the feed', () => {
  it('carries the list with its age, no client id, and leaves the section out when never read', () => {
    const c = new KeysCache();
    c.set(LIST, new Date(NOW));
    const f = buildDashboardFeed({ hub: null, batches: [], now: new Date(NOW), keys: c.get() }) as { keys?: { at: string; rows: unknown[]; read: string } };
    expect(f.keys?.at).toBe(new Date(NOW).toISOString());
    expect(f.keys?.rows).toHaveLength(1);
    expect(JSON.stringify(f)).not.toContain('ca14c1dd');
    expect('keys' in (buildDashboardFeed({ hub: null, batches: [], now: new Date(NOW), keys: null }) as object)).toBe(false);
  });
});
