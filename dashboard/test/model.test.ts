import { describe, expect, test } from 'bun:test';
import fixture from '../fixtures/dashboard.json';
import { ageText, healthOf, parseDashboard, sortFindings, switchState, STALE_MS, type ServiceRow } from '../src/model.ts';
import { httpFeed } from '../src/data.ts';

const NOW = Date.parse('2026-11-16T22:01:00Z');
const side = (ok: boolean, at = '2026-11-16T22:00:00Z', lagS: number | null = null) => ({ ok, checkedAt: at, detail: '', lagS });
const svc = (o: Partial<ServiceRow> = {}): ServiceRow => ({ name: 's', hostname: 'h', active: 'lab', dataClass: 'stateless', pinned: false, auto: false, lab: side(true), cloud: side(true), ...o });

describe('healthOf', () => {
  test('a missing record is unknown, never ok', () => expect(healthOf(null, NOW)).toBe('unknown'));
  test('a stale record is unknown', () => expect(healthOf(side(true, new Date(NOW - STALE_MS - 1000).toISOString()), NOW)).toBe('unknown'));
  test('a bad time is unknown', () => expect(healthOf(side(true, 'nope'), NOW)).toBe('unknown'));
  test('fresh ok and fresh down', () => {
    expect(healthOf(side(true), NOW)).toBe('ok');
    expect(healthOf(side(false), NOW)).toBe('down');
  });
});

describe('switchState', () => {
  test('a pinned service never switches', () => expect(switchState(svc({ pinned: true }), NOW).allowed).toBe(false));
  test('the target side must be healthy', () => {
    expect(switchState(svc({ cloud: side(false) }), NOW).allowed).toBe(false);
    expect(switchState(svc({ cloud: null }), NOW).allowed).toBe(false);
  });
  test('a replicated service needs a known lag', () => {
    expect(switchState(svc({ dataClass: 'replicated' }), NOW).allowed).toBe(false);
    expect(switchState(svc({ dataClass: 'replicated', cloud: side(true, '2026-11-16T22:00:00Z', 4) }), NOW).allowed).toBe(true);
  });
  test('says whether it waits for a tap', () => {
    expect(switchState(svc({ auto: true }), NOW).reason).toContain('on its own');
    expect(switchState(svc(), NOW).reason).toContain('tap');
  });
});

describe('parseDashboard', () => {
  test('reads the fixture with no problems', () => {
    const r = parseDashboard(fixture);
    expect(r.problems).toEqual([]);
    expect(r.data.services.length).toBe(4);
    expect(r.data.cve?.findings.length).toBe(3);
  });
  test('a non-object feed yields empty data and problems, not healthy defaults', () => {
    const r = parseDashboard(null);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.data.services).toEqual([]);
    expect(r.data.cve).toBeNull();
  });
  test('drops unreadable rows and says so', () => {
    const r = parseDashboard({ ...fixture, services: [{ name: 'x' }, fixture.services[0]], alerts: [{ monitor: 'm', state: 'sideways' }] });
    expect(r.data.services.length).toBe(1);
    expect(r.data.alerts.length).toBe(0);
    expect(r.problems).toContain('a service row was unreadable');
    expect(r.problems).toContain('an alert row was unreadable');
  });
  test('a service side with no ok flag is no record', () => {
    const r = parseDashboard({ ...fixture, services: [{ ...fixture.services[0], lab: { checkedAt: 'x' } }] });
    expect(r.data.services[0]?.lab).toBeNull();
  });
  test('caps long text', () => {
    const r = parseDashboard({ ...fixture, needs: [{ id: 'a', title: 't'.repeat(900), why: 'w', step: 's', since: 'x' }] });
    expect(r.data.needs[0]?.title.length).toBe(160);
  });
});

test('sortFindings puts exploited first, then severity', () => {
  const s = sortFindings(parseDashboard(fixture).data.cve!.findings);
  expect(s.map((f) => f.id)).toEqual(['CVE-2026-0002', 'CVE-2026-0001', 'CVE-2026-0003']);
});

test('ageText', () => {
  expect(ageText('2026-11-16T22:00:30Z', NOW)).toBe('30 seconds ago');
  expect(ageText('x', NOW)).toBe('at an unknown time');
});

describe('httpFeed', () => {
  test('throws on an HTTP error so the app shows the banner', async () => {
    const f = httpFeed('/x', null, (async () => new Response('no', { status: 502 })) as unknown as typeof fetch);
    await expect(f.load()).rejects.toThrow('502');
  });
  test('has no switch without a switch URL', () => expect(httpFeed('/x', null).requestSwitch).toBeNull());
  test('posts the switch request', async () => {
    let body = '';
    const f = httpFeed('/x', '/sw', (async (_u: string, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ message: 'queued' }));
    }) as unknown as typeof fetch);
    expect(await f.requestSwitch!('dash', 'cloud')).toEqual({ ok: true, message: 'queued' });
    expect(JSON.parse(body)).toEqual({ service: 'dash', to: 'cloud' });
  });
});

test('uptime: a bad state is unknown, never ok, and a strip keeps the newest 150 cells', () => {
  const cells = Array.from({ length: 160 }, (_, i) => ({ at: `2026-11-16T${String(i % 24).padStart(2, '0')}:00:00Z`, state: i === 159 ? 'fine' : 'ok' }));
  const r = parseDashboard({ ...fixture, history: { ...fixture.history, uptime: { 'dash': cells, 'Bad Name': cells, 'x': [{ at: 'nope', state: 'ok' }] } } });
  const u = r.data.history!.uptime;
  expect(u['dash']?.length).toBe(150);
  expect(u['dash']?.at(-1)?.state).toBe('unknown');
  expect(Object.keys(u)).toEqual(['dash']);
});

describe('tiles with an unread live section', () => {
  test('Needs you and Alerts down are unknown, not zero, when the feed lacked them', async () => {
    const { tiles } = await import('../src/views.ts');
    const { data } = parseDashboard({ generatedAt: '2026-11-16T22:00:00Z', services: [] });
    expect(data.unread).toEqual(['needs', 'alerts']);
    const html = tiles(data, Date.parse('2026-11-16T22:00:00Z'));
    expect(html).not.toContain('>0<');
    expect(html.match(/Unknown|unknown/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('rows that fail validation', () => {
  test('an unreadable needs or alerts row marks its section unread, so the tile is not a healthy zero', async () => {
    const { tiles, nowView, alertsView } = await import('../src/views.ts');
    const now = Date.parse('2026-11-16T22:00:00Z');
    const { data } = parseDashboard({ generatedAt: '2026-11-16T22:00:00Z', services: [], needs: [{}], alerts: [{ monitor: 'x', state: 'sideways' }] });
    expect(data.unread.sort()).toEqual(['alerts', 'needs']);
    expect(tiles(data, now)).not.toContain('>0<');
    expect(nowView(data, now)).toContain('unknown whether anything needs you');
    expect(alertsView(data, now)).toContain('unknown whether any alert is open');
  });
});

describe('CVE coverage gaps', () => {
  const base = { checkedAt: '2026-11-16T12:00:00Z', hosts: 2, packages: 10, advisories: 3, notChecked: [], findings: [] };
  test('an unread exploited list makes the Exploited tile unknown and the view not clean', async () => {
    const { tiles, cveView } = await import('../src/views.ts');
    const now = Date.parse('2026-11-16T12:01:00Z');
    const { data } = parseDashboard({ generatedAt: '2026-11-16T12:00:00Z', services: [], needs: [], alerts: [], cve: { ...base, gaps: ['CISA could not be read, so nothing is marked as exploited'], kevChecked: false } });
    expect(data.cve?.kevChecked).toBe(false);
    expect(tiles(data, now)).not.toMatch(/Exploited CVEs[^]*?>0</);
    expect(cveView(data, now)).toContain('not a clean result');
  });
  test('a feed that carries no coverage fields is not read as complete', () => {
    const { data } = parseDashboard({ generatedAt: 'x', services: [], needs: [], alerts: [], cve: base });
    expect(data.cve?.kevChecked).toBe(false);
  });
});
