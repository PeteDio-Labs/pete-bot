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

describe('stale cached live sections and dropped CVE findings', () => {
  test('a cached feed older than five minutes shows needs and alerts as unknown', async () => {
    const { tiles, nowView } = await import('../src/views.ts');
    const { data } = parseDashboard({ generatedAt: '2026-11-16T22:00:00Z', services: [], needs: [], alerts: [] });
    const late = Date.parse('2026-11-16T22:06:00Z');
    expect(nowView(data, late)).toContain('out of date');
    expect(tiles(data, late)).not.toContain('>0<');
    expect(nowView(data, Date.parse('2026-11-16T22:01:00Z'))).toContain('Nothing needs you');
  });
  test('a CVE finding that fails validation makes the coverage unknown, not clean', async () => {
    const { tiles, cveView } = await import('../src/views.ts');
    const now = Date.parse('2026-11-16T12:01:00Z');
    const { data } = parseDashboard({ generatedAt: '2026-11-16T12:00:00Z', services: [], needs: [], alerts: [], cve: { checkedAt: '2026-11-16T12:00:00Z', hosts: 1, packages: 1, advisories: 1, notChecked: [], gaps: [], kevChecked: true, findings: [{ id: 'CVE-1', pkg: 'p', severity: 'sideways', kev: true }] } });
    expect(data.cve?.kevChecked).toBe(false);
    expect(cveView(data, now)).toContain('not a clean result');
    expect(tiles(data, now)).not.toMatch(/Exploited CVEs[^]*?>0</);
  });
});

describe('dropped services and capped CVE detail', () => {
  test('a dropped service row makes the Probes tile unknown, not a green total', async () => {
    const { tiles, watchdogMeters } = await import('../src/views.ts');
    const now = Date.parse('2026-11-16T22:00:00Z');
    const fresh = { ok: true, checkedAt: '2026-11-16T21:59:30Z', detail: '', lagS: null };
    const { data } = parseDashboard({ generatedAt: '2026-11-16T22:00:00Z', needs: [], alerts: [], services: [{ name: 'a', hostname: 'h', active: 'lab', lab: fresh, cloud: fresh }, { name: 'b', active: 'sideways' }] });
    expect(data.droppedServices).toBe(1);
    expect(tiles(data, now)).not.toContain('2 of 2 healthy');
    expect(watchdogMeters(data, now)).toContain('1 service row unreadable');
  });
  test('the Exploited tile uses the full count when the detail list is capped', async () => {
    const { tiles, cveView } = await import('../src/views.ts');
    const now = Date.parse('2026-11-16T12:01:00Z');
    const f = { id: 'CVE-1', pkg: 'p', host: 'h', severity: 'high', fixed: null, kev: true };
    const { data } = parseDashboard({ generatedAt: '2026-11-16T12:00:00Z', services: [], needs: [], alerts: [], cve: { checkedAt: '2026-11-16T12:00:00Z', hosts: 1, packages: 1, advisories: 1, notChecked: [], gaps: [], kevChecked: true, exploited: 16, findings: [f] } });
    expect(tiles(data, now)).toContain('16');
    expect(cveView(data, now)).toContain('capped');
  });
});

describe('no card is not the same as nothing wrong', () => {
  test('Now says an alert is down when no action card was written', async () => {
    const { nowView } = await import('../src/views.ts');
    const now = Date.parse('2026-11-16T22:00:30Z');
    const { data } = parseDashboard({ generatedAt: '2026-11-16T22:00:00Z', services: [], needs: [], alerts: [{ monitor: 'plex', state: 'down', since: '2026-11-16T21:00:00Z', triage: 'off' }] });
    const html = nowView(data, now);
    expect(html).toContain('1 alert is down');
    expect(html).not.toContain('Nothing needs you');
  });
  test('a CVE run older than two days no longer gives a green Exploited tile', async () => {
    const { tiles } = await import('../src/views.ts');
    const { data } = parseDashboard({ generatedAt: '2026-11-20T00:00:00Z', services: [], needs: [], alerts: [], cve: { checkedAt: '2026-11-16T00:00:00Z', hosts: 1, packages: 1, advisories: 1, notChecked: [], gaps: [], kevChecked: true, findings: [] } });
    expect(tiles(data, Date.parse('2026-11-20T00:00:30Z'))).not.toMatch(/Exploited CVEs[^]*?>0</);
  });
});

describe('summary counters that cannot be read stay unknown', () => {
  const base = { generatedAt: '2026-11-18T00:00:00Z', services: [], needs: [], alerts: [] };
  test('a Plane summary with an unreadable counter is dropped, not shown as zeros', async () => {
    const { planeView } = await import('../src/views.ts');
    const { data, problems } = parseDashboard({ ...base, plane: { checkedAt: '2026-11-18T00:00:00Z', open: 'unreadable' } });
    expect(data.plane).toBeNull();
    expect(problems.join(' ')).toContain('Plane summary had an unreadable counter');
    expect(planeView(data, Date.parse('2026-11-18T00:01:00Z'))).toContain('unknown');
  });
  test('an empty triage ledger is dropped', () => {
    expect(parseDashboard({ ...base, triage: {} }).data.triage).toBeNull();
  });
  test('a history row with only a day hides the history', () => {
    const { data } = parseDashboard({ ...base, history: { alerts: [], cve: [{ day: '2026-11-17' }], drills: [], uptime: {} } });
    expect(data.history).toBeNull();
  });
  test('lost cycle items are named in the Plane view', async () => {
    const { planeView } = await import('../src/views.ts');
    const { data } = parseDashboard({ ...base, plane: { checkedAt: '2026-11-18T00:00:00Z', open: 0, needsPedro: 0, inReview: 0, cycle: 'Cycle 9', lost: 2 } });
    const html = planeView(data, Date.parse('2026-11-18T00:01:00Z'));
    expect(html).toContain('2 items in the cycle could not be found');
    expect(html).toContain('Cycle 9');
  });
  test('Now does not say nothing needs you when the alert list was unread', async () => {
    const { nowView } = await import('../src/views.ts');
    const { data } = parseDashboard({ generatedAt: '2026-11-18T00:00:00Z', services: [], needs: [] });
    expect(nowView(data, Date.parse('2026-11-18T00:00:30Z'))).not.toContain('Nothing needs you');
  });
});
