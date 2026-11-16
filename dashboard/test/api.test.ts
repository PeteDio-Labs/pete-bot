import { describe, expect, test } from 'bun:test';
import { handle, type Db, type Req } from '../api/handler.ts';
import { parseDashboard } from '../src/model.ts';
import fixture from '../fixtures/dashboard.json';

const NOW = Date.parse('2026-11-16T22:00:00Z');
const memDb = (): Db & { items: Map<string, Record<string, unknown>> } => {
  const items = new Map<string, Record<string, unknown>>();
  return { items, get: async (pk, sk) => items.get(`${pk}|${sk}`) ?? null, put: async (i) => void items.set(`${i.pk}|${i.sk}`, i) };
};
const post = (path: string, body: unknown): Req => ({ method: 'POST', path, body: JSON.stringify(body) });
const call = (db: Db, r: Req) => handle(r, db, () => NOW);
const registry = [
  { name: 'dash', hostname: 'd.example.test', active: 'cloud', dataClass: 'stateless', pinned: false, auto: true },
  { name: 'plex', hostname: 'p.example.test', active: 'lab', dataClass: 'snapshot', pinned: true, auto: false },
];

describe('ingest status', () => {
  test('stores a record and keeps the watchdog time', async () => {
    const db = memDb();
    const r = await call(db, post('/api/ingest/status', { service: 'dash', side: 'cloud', ok: true, checkedAt: '2026-11-16T21:59:00Z', detail: '200' }));
    expect(r.statusCode).toBe(200);
    expect(db.items.get('dash#cloud|status')?.checkedAt).toBe('2026-11-16T21:59:00.000Z');
  });
  test.each([
    [{ service: 'Dash', side: 'cloud', ok: true, checkedAt: '2026-11-16T21:59:00Z' }],
    [{ service: 'dash', side: 'moon', ok: true, checkedAt: '2026-11-16T21:59:00Z' }],
    [{ service: 'dash', side: 'lab', ok: 'yes', checkedAt: '2026-11-16T21:59:00Z' }],
    [{ service: 'dash', side: 'lab', ok: true, checkedAt: 'soon' }],
    [{ service: 'dash', side: 'lab', ok: true, checkedAt: '2026-11-16T22:10:00Z' }],
    [{ service: 'dash', side: 'lab', ok: true, checkedAt: '2026-11-16T21:59:00Z', lagS: -1 }],
  ])('refuses %p', async (body) => {
    const db = memDb();
    expect((await call(db, post('/api/ingest/status', body))).statusCode).toBe(400);
    expect(db.items.size).toBe(0);
  });
  test('a body that is not JSON is a 400', async () => {
    expect((await call(memDb(), { method: 'POST', path: '/api/ingest/status', body: '{' })).statusCode).toBe(400);
  });
});

describe('ingest section and the dashboard read', () => {
  test('assembles the SPA shape, and an unreported side is null', async () => {
    const db = memDb();
    await call(db, post('/api/ingest/section', { name: 'services', body: registry }));
    await call(db, post('/api/ingest/section', { name: 'needs', body: fixture.needs }));
    await call(db, post('/api/ingest/status', { service: 'dash', side: 'cloud', ok: true, checkedAt: '2026-11-16T21:59:30Z', lagS: null }));
    const res = await call(db, { method: 'GET', path: '/api/dashboard', body: null });
    expect(res.statusCode).toBe(200);
    const parsed = parseDashboard(JSON.parse(res.body));
    expect(parsed.data.services.map((s) => s.name)).toEqual(['dash', 'plex']);
    expect(parsed.data.services[0]?.cloud?.checkedAt).toBe('2026-11-16T21:59:30.000Z');
    expect(parsed.data.services[0]?.lab).toBeNull();
    expect(parsed.data.needs.length).toBe(1);
    expect(parsed.data.source).toBe('aws');
  });
  test('missing sections are null, so the SPA names them in its banner', async () => {
    const res = await call(memDb(), { method: 'GET', path: '/api/dashboard', body: null });
    const parsed = parseDashboard(JSON.parse(res.body));
    expect(parsed.data.cve).toBeNull();
    expect(parsed.problems.length).toBeGreaterThan(0);
  });
  test('refuses an unknown section name', async () => {
    expect((await call(memDb(), post('/api/ingest/section', { name: 'secrets', body: {} }))).statusCode).toBe(400);
  });
});

describe('switch', () => {
  const seeded = async () => {
    const db = memDb();
    await call(db, post('/api/ingest/section', { name: 'services', body: registry }));
    return db;
  };
  test('records a request and moves nothing', async () => {
    const db = await seeded();
    const r = await call(db, post('/api/switch', { service: 'dash', to: 'lab' }));
    expect(r.statusCode).toBe(202);
    expect(JSON.parse(r.body).message).toContain('Nothing has moved');
    expect([...db.items.keys()].some((k) => k.startsWith('switch#dash|'))).toBe(true);
    expect(db.items.get('section#services|latest')).toBeDefined();
  });
  test('refuses a pinned service, an unknown one, and a no-op', async () => {
    const db = await seeded();
    expect((await call(db, post('/api/switch', { service: 'plex', to: 'cloud' }))).statusCode).toBe(409);
    expect((await call(db, post('/api/switch', { service: 'ghost', to: 'cloud' }))).statusCode).toBe(404);
    expect((await call(db, post('/api/switch', { service: 'dash', to: 'cloud' }))).statusCode).toBe(409);
    expect([...db.items.keys()].filter((k) => k.startsWith('switch#')).length).toBe(0);
  });
});

test('unknown routes are 404', async () => {
  expect((await call(memDb(), { method: 'GET', path: '/nope', body: null })).statusCode).toBe(404);
});

describe('health', () => {
  test('answers ok with no data when the table reads', async () => {
    const db = memDb();
    await call(db, post('/api/ingest/section', { name: 'cve', body: { secret: 'x' } }));
    const r = await call(db, { method: 'GET', path: '/api/health', body: null });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
  });
  test('is a 500 when the table cannot be read, so the health check goes red', async () => {
    const broken: Db = { get: async () => { throw new Error('table gone'); }, put: async () => {} };
    const r = await call(broken, { method: 'GET', path: '/api/health', body: null });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain('table gone');
  });
});
