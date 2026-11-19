/** The Secrets screen's model and client: the same-origin guard, the verdict, the run follower and the requests. The network is faked. */
import { describe, expect, it } from 'bun:test';
import { follow, keyLine, keysApi, keysVerdict, sameOriginPath, type KeyList, type KeyRow, type KeysApi, type RunRead } from '../src/keys.ts';

const row = (o: Partial<KeyRow> = {}): KeyRow => ({ name: 'muse', owner: 'pedro', hasToken: true, version: '3', expires: '2027-02-10T00:00:00Z', daysLeft: 84, expired: false, renewSoon: false, inCallers: true, ...o });
const list = (rows: KeyRow[], unparsed = 0): KeyList => ({ rows, read: 'keys list: read 1 agents in callers.yml and 1 Vault entries; 0 expired', unparsed });
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('sameOriginPath', () => {
  it('accepts a path on this origin and drops a trailing slash', () => {
    expect(sameOriginPath('/api/keys')).toBe('/api/keys');
    expect(sameOriginPath(' /api/keys/ ')).toBe('/api/keys');
  });
  it('refuses another origin, a scheme-relative address, a dot segment and nothing', () => {
    for (const bad of ['https://evil.example/api/keys', '//evil.example/api/keys', 'api/keys', '/api/../keys', '/a b', '/api/keys?x=1', '', null, undefined]) expect(sameOriginPath(bad as string | null)).toBeNull();
  });
});

describe('keysVerdict', () => {
  it('is unknown for a list that was not read, with the reason', () => {
    expect(text(keysVerdict(null, 'GitHub answered 502'))).toContain('The key list was not read');
    expect(text(keysVerdict(null, 'GitHub answered 502'))).toContain('GitHub answered 502');
  });
  it('is never all clear for an empty or partly unreadable list', () => {
    expect(text(keysVerdict(list([])))).toContain('No keys were listed');
    expect(text(keysVerdict(list([row()], 2)))).toContain('2 lines of the key list could not be read');
  });
  it('ranks expired over expiring over pending over ok', () => {
    const exp = row({ name: 'old', expired: true, daysLeft: null });
    const soon = row({ name: 'batsy', renewSoon: true, daysLeft: 13 });
    const pend = row({ name: 'staging', hasToken: false });
    expect(text(keysVerdict(list([row(), soon, pend, exp])))).toContain('1 key expired');
    expect(text(keysVerdict(list([row(), soon, pend])))).toContain('1 key expires within 21 days');
    expect(text(keysVerdict(list([row(), pend])))).toContain('differs from the list in git');
    expect(text(keysVerdict(list([row(), row({ name: 'b', daysLeft: 30 })])))).toContain('All 2 keys are valid');
    expect(text(keysVerdict(list([row(), row({ name: 'b', daysLeft: 30 })])))).toContain('expires in 30 days');
  });
  it('escapes a name', () => {
    const h = keysVerdict(list([row({ name: '<b>x', expired: true })]));
    expect(h).not.toContain('<b>x');
    expect(h).toContain('&lt;b&gt;x');
    expect(h).not.toContain('&amp;lt;');
    expect(keysVerdict(null, 'it\'s down')).toContain('it&#39;s down');
  });
});

describe('keyLine', () => {
  it('says what a key lacks, and never shows a value', () => {
    expect(keyLine(row({ hasToken: false }))).toContain('not created yet');
    expect(keyLine(row({ inCallers: false }))).toContain('Apply changes revokes it');
    expect(keyLine(row())).toBe('Owner pedro. Expires 2027-02-10 (84 days left).');
  });
});

describe('follow', () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => void (t += ms) }; };
  const api = (reads: RunRead[]): KeysApi => ({ start: async () => ({ requestId: 'x', url: null }), read: async () => reads.shift() ?? { state: 'running' } });
  it('returns a finished run and reports each state on the way', async () => {
    const seen: string[] = [];
    const r = await follow(api([{ state: 'queued' }, { state: 'waiting_tap' }, { state: 'done' }]), 'pb-a-000000', 'renew', { limitMs: 60_000, onState: (s) => seen.push(s.state), ...clock() });
    expect(r.state).toBe('done');
    expect(seen).toEqual(['queued', 'waiting_tap', 'done']);
  });
  it('rides out a failed read, and ends with a reason after four in a row', async () => {
    let n = 0;
    const flaky: KeysApi = { start: async () => ({ requestId: 'x', url: null }), read: async () => { if (++n === 2) throw new Error('offline'); return n > 2 ? { state: 'done' } : { state: 'waiting_tap' }; } };
    expect((await follow(flaky, 'pb-a-000000', 'renew', { limitMs: 60_000, ...clock() })).state).toBe('done');
    const dead: KeysApi = { start: async () => ({ requestId: 'x', url: null }), read: async () => { throw new Error('offline'); } };
    const r = await follow(dead, 'pb-a-000000', 'renew', { limitMs: 600_000, ...clock() });
    expect(r.state).toBe('failed');
    expect(r.error).toContain('may still be going');
  });
  it('turns a run that never ends into a failure that says so', async () => {
    const r = await follow(api([]), 'pb-a-000000', 'sync', { limitMs: 9_000, ...clock() });
    expect(r.state).toBe('failed');
    expect(r.error).toContain('did not finish in time');
  });
  it('turns a run that never appears into a failure', async () => {
    const r = await follow(api(Array.from({ length: 20 }, () => ({ state: 'not_found' as const }))), 'pb-a-000000', 'list', { limitMs: 600_000, ...clock() });
    expect(r.state).toBe('failed');
    expect(r.error).toContain('never appeared');
  });
});

describe('keysApi', () => {
  it('posts the action and name as JSON to the same origin, and reads the run with the action', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return Response.json(init.method === 'POST' ? { requestId: 'pb-a-000000', run: { url: 'u' } } : { state: 'done', list: list([row()]) }, { status: init.method === 'POST' ? 202 : 200 });
    }) as unknown as typeof fetch;
    const a = keysApi('/api/keys', f);
    expect(await a.start('rotate', 'muse')).toEqual({ requestId: 'pb-a-000000', url: 'u' });
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ action: 'rotate', name: 'muse' });
    expect(calls[0]![1].credentials).toBe('same-origin');
    expect((await a.read('pb-a-000000', 'list')).list?.rows.length).toBe(1);
    expect(calls[1]![0]).toBe('/api/keys/runs/pb-a-000000?action=list');
  });
  it('refuses a run state it does not know', async () => {
    const a = keysApi('/api/keys', (async () => Response.json({ state: 'exploded' })) as unknown as typeof fetch);
    await expect(a.read('pb-a-000000', 'list')).rejects.toThrow('does not know');
  });
  it('throws the server’s reason on a refusal', async () => {
    const a = keysApi('/api/keys', (async () => Response.json({ error: 'too many key changes this hour' }, { status: 429 })) as unknown as typeof fetch);
    await expect(a.start('sync')).rejects.toThrow('too many key changes');
  });
});

describe('keysVerdict with an age', () => {
  it('reads a list older than 36 hours as unknown, even when every key looked valid', () => {
    const fresh = text(keysVerdict(list([row()]), null, 3_600_000));
    expect(fresh).toContain('All 1 key are valid');
    const old = text(keysVerdict(list([row()]), null, 40 * 3_600_000));
    expect(old).toContain('The key list is out of date');
    expect(old).toContain('40 hours ago');
    expect(old).not.toContain('All 1 key');
  });
});

describe('the example rows', () => {
  it('name no real key and never read as a real list', async () => {
    const { EXAMPLE_LIST } = await import('../src/keys.ts');
    expect(EXAMPLE_LIST.rows.every((r) => r.name.startsWith('example-'))).toBe(true);
    expect(EXAMPLE_LIST.read).toContain('not read from the lab');
  });
});

describe('agedList and a read time in the future', () => {
  const now = Date.parse('2026-11-19T00:00:00Z');
  it('works the flags out again from the expiry date', async () => {
    const { agedList } = await import('../src/keys.ts');
    const l = agedList(list([row({ expires: '2026-12-01T00:00:00Z', daysLeft: 40, renewSoon: false }), row({ name: 'old', expires: '2026-11-01T00:00:00Z', daysLeft: 5, expired: false }), row({ name: 'nodate', expires: null, daysLeft: 9 })]), now);
    expect(l.rows[0]).toMatchObject({ daysLeft: 12, renewSoon: true, expired: false });
    expect(l.rows[1]).toMatchObject({ expired: true, daysLeft: 0 });
    expect(l.rows[2]).toMatchObject({ daysLeft: 9 });
  });
  it('reads a time ahead of the clock as unknown', () => {
    expect(text(keysVerdict(list([row()]), null, -3_600_000))).toContain('read time in the future');
    expect(text(keysVerdict(list([row()]), null, -60_000))).toContain('All 1 key are valid');
  });
});
