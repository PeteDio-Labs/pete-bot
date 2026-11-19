import { describe, expect, test } from 'bun:test';
import { readStaging, cachedStaging } from './staging.js';

const now = new Date('2026-11-19T12:00:00Z');
const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });

describe('readStaging', () => {
  test('passes the clock through', async () => {
    const s = { state: 'up', uptimeSec: 60, shutsDownInSec: 86_340, checkedAt: 'x' };
    expect(await readStaging('http://x', 't', now, ok(s))).toEqual(s);
  });
  test('every failure is unknown, and says why', async () => {
    expect((await readStaging('http://x', '', now, ok({}))).state).toBe('unknown');
    expect(((await readStaging('http://x', 't', now, async () => ({ ok: false, status: 401, json: async () => ({}) }))).detail as string)).toContain('401');
    expect((await readStaging('http://x', 't', now, async () => { throw new Error('boom'); })).state).toBe('unknown');
    expect((await readStaging('http://x', 't', now, ok('nope'))).state).toBe('unknown');
  });
  test('caches for twenty seconds', async () => {
    let n = 0;
    const get = cachedStaging('http://x', 't', async () => { n++; return { ok: true, status: 200, json: async () => ({ state: 'stopped' }) }; });
    await get(now);
    await get(new Date(now.getTime() + 5_000));
    expect(n).toBe(1);
    await get(new Date(now.getTime() + 30_000));
    expect(n).toBe(2);
  });
});
