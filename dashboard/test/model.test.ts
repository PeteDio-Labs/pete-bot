import { describe, expect, test } from 'bun:test';
import fixture from '../fixtures/dashboard.json';
import { ageText, clockFor, DEMO_SOURCE, healthOf, parseDashboard, sortFindings, switchState, STALE_MS, type ServiceRow } from '../src/model.ts';
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
    const { attention } = await import('../src/views.ts');
    const all = attention(data, Date.parse('2026-11-16T22:00:00Z'));
    expect(all.filter((a) => a.state === 'unknown' && a.tab === 'act').length).toBe(2);
    expect(tiles(data, Date.parse('2026-11-16T22:00:00Z'))).not.toContain('>0<');
  });
});

describe('rows that fail validation', () => {
  test('an unreadable needs or alerts row marks its section unread, so the tile is not a healthy zero', async () => {
    const { tiles, nowView, actView } = await import('../src/views.ts');
    const now = Date.parse('2026-11-16T22:00:00Z');
    const { data } = parseDashboard({ generatedAt: '2026-11-16T22:00:00Z', services: [], needs: [{}], alerts: [{ monitor: 'x', state: 'sideways' }] });
    expect(data.unread.sort()).toEqual(['alerts', 'needs']);
    expect(tiles(data, now)).not.toContain('>0<');
    expect(nowView(data, now)).toContain('unknown whether anything needs you');
    expect(actView(data, now)).toContain('unknown whether anything needs a fix');
  });
});

describe('CVE coverage gaps', () => {
  const base = { checkedAt: '2026-11-16T12:00:00Z', hosts: 2, packages: 10, advisories: 3, notChecked: [], findings: [] };
  test('an unread exploited list makes the Exploited tile unknown and the view not clean', async () => {
    const { tiles, healthView } = await import('../src/views.ts');
    const now = Date.parse('2026-11-16T12:01:00Z');
    const { data } = parseDashboard({ generatedAt: '2026-11-16T12:00:00Z', services: [], needs: [], alerts: [], cve: { ...base, gaps: ['CISA could not be read, so nothing is marked as exploited'], kevChecked: false } });
    expect(data.cve?.kevChecked).toBe(false);
    expect(tiles(data, now)).toMatch(/Patches[^]*?Unknown/);
    expect(healthView(data, now)).toContain('not a clean result');
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
    const { tiles, healthView } = await import('../src/views.ts');
    const now = Date.parse('2026-11-16T12:01:00Z');
    const { data } = parseDashboard({ generatedAt: '2026-11-16T12:00:00Z', services: [], needs: [], alerts: [], cve: { checkedAt: '2026-11-16T12:00:00Z', hosts: 1, packages: 1, advisories: 1, notChecked: [], gaps: [], kevChecked: true, findings: [{ id: 'CVE-1', pkg: 'p', severity: 'sideways', kev: true }] } });
    expect(data.cve?.kevChecked).toBe(false);
    expect(healthView(data, now)).toContain('not a clean result');
    expect(tiles(data, now)).toMatch(/Patches[^]*?Unknown/);
  });
});

describe('dropped services and capped CVE detail', () => {
  test('a dropped service row makes the Probes tile unknown, not a green total', async () => {
    const { tiles, watchdogMeters } = await import('../src/views.ts');
    const now = Date.parse('2026-11-16T22:00:00Z');
    const fresh = { ok: true, checkedAt: '2026-11-16T21:59:30Z', detail: '', lagS: null };
    const { data } = parseDashboard({ generatedAt: '2026-11-16T22:00:00Z', needs: [], alerts: [], services: [{ name: 'a', hostname: 'h', active: 'lab', dataClass: 'stateless', lab: fresh, cloud: fresh }, { name: 'b', active: 'sideways' }] });
    expect(data.droppedServices).toBe(1);
    const { nowView } = await import('../src/views.ts');
    expect(nowView(data, now)).toContain('A service row was unreadable');
    expect(nowView(data, now)).not.toContain('All clear');
    expect(watchdogMeters(data, now)).toContain('1 service row unreadable');
  });
  test('the Exploited tile uses the full count when the detail list is capped', async () => {
    const { tiles, healthView } = await import('../src/views.ts');
    const now = Date.parse('2026-11-16T12:01:00Z');
    const f = { id: 'CVE-1', pkg: 'p', host: 'h', severity: 'high', fixed: null, kev: true };
    const { data } = parseDashboard({ generatedAt: '2026-11-16T12:00:00Z', services: [], needs: [], alerts: [], cve: { checkedAt: '2026-11-16T12:00:00Z', hosts: 1, packages: 1, advisories: 1, notChecked: [], gaps: [], kevChecked: true, exploited: 16, findings: [f] } });
    expect(tiles(data, now)).toContain('16 exploited');
    expect(healthView(data, now)).toContain('capped');
  });
});

describe('no card is not the same as nothing wrong', () => {
  test('Now says an alert is down when no action card was written', async () => {
    const { nowView } = await import('../src/views.ts');
    const now = Date.parse('2026-11-16T22:00:30Z');
    const { data } = parseDashboard({ generatedAt: '2026-11-16T22:00:00Z', services: [], needs: [], alerts: [{ monitor: 'plex', state: 'down', since: '2026-11-16T21:00:00Z', triage: 'off' }] });
    const html = nowView(data, now);
    expect(html).toContain('plex is down');
    expect(html).toContain('Wrong now');
    expect(html).not.toContain('Nothing needs you');
  });
  test('a CVE run older than two days no longer gives a green Exploited tile', async () => {
    const { tiles } = await import('../src/views.ts');
    const { data } = parseDashboard({ generatedAt: '2026-11-20T00:00:00Z', services: [], needs: [], alerts: [], cve: { checkedAt: '2026-11-16T00:00:00Z', hosts: 1, packages: 1, advisories: 1, notChecked: [], gaps: [], kevChecked: true, findings: [] } });
    expect(tiles(data, Date.parse('2026-11-20T00:00:30Z'))).toMatch(/Patches[^]*?Unknown/);
  });
});

describe('summary counters that cannot be read stay unknown', () => {
  const base = { generatedAt: '2026-11-18T00:00:00Z', services: [], needs: [], alerts: [] };
  test('a Plane summary with an unreadable counter is dropped, not shown as zeros', async () => {
    const { workView } = await import('../src/views.ts');
    const { data, problems } = parseDashboard({ ...base, plane: { checkedAt: '2026-11-18T00:00:00Z', open: 'unreadable' } });
    expect(data.plane).toBeNull();
    expect(problems.join(' ')).toContain('Plane summary had an unreadable counter');
    expect(workView(data, Date.parse('2026-11-18T00:01:00Z'))).toContain('unknown');
  });
  test('an empty triage ledger is dropped', () => {
    expect(parseDashboard({ ...base, triage: {} }).data.triage).toBeNull();
  });
  test('a history row with only a day hides the history', () => {
    const { data } = parseDashboard({ ...base, history: { alerts: [], cve: [{ day: '2026-11-17' }], drills: [], uptime: {} } });
    expect(data.history).toBeNull();
  });
  test('lost cycle items are named in the Plane view', async () => {
    const { workView } = await import('../src/views.ts');
    const { data } = parseDashboard({ ...base, plane: { checkedAt: '2026-11-18T00:00:00Z', open: 0, needsPedro: 0, inReview: 0, cycle: 'Cycle 9', lost: 2 } });
    const html = workView(data, Date.parse('2026-11-18T00:01:00Z'));
    expect(html).toContain('2 items in the cycle could not be found');
    expect(html).toContain('Cycle 9');
  });
  test('Now does not say nothing needs you when the alert list was unread', async () => {
    const { nowView } = await import('../src/views.ts');
    const { data } = parseDashboard({ generatedAt: '2026-11-18T00:00:00Z', services: [], needs: [] });
    expect(nowView(data, Date.parse('2026-11-18T00:00:30Z'))).not.toContain('Nothing needs you');
  });
});

describe('a service whose data class cannot be read', () => {
  test('is dropped and counted, never treated as stateless', () => {
    const { data, problems } = parseDashboard({ generatedAt: 'x', needs: [], alerts: [], services: [{ name: 'a', hostname: 'h', active: 'lab' }, { name: 'b', hostname: 'h', active: 'lab', dataClass: 'sideways' }] });
    expect(data.services).toEqual([]);
    expect(data.droppedServices).toBe(2);
    expect(problems.filter((x) => x === 'a service row was unreadable').length).toBe(2);
  });
});

describe('charts with no data to draw', () => {
  const zero = { generatedAt: '2026-11-18T00:00:00Z', needs: [], alerts: [], services: [], history: { alerts: [{ day: '2026-11-17', act: 0, noAction: 0, unreadable: 0 }], cve: [{ day: '2026-11-17', critical: 0, high: 0, medium: 0, low: 0 }], drills: [{ label: 'd', detectS: 0, flipS: 0, clientS: 0, result: 'passed' }], uptime: {} } };
  test('an all-zero history renders a note and its table instead of throwing', async () => {
    const { alertVolumeChart, cveHistoryChart, drillChart } = await import('../src/views.ts');
    const { data } = parseDashboard(zero);
    for (const html of [alertVolumeChart(data), cveHistoryChart(data), drillChart(data)]) {
      expect(html).toContain('Every value is zero');
      expect(html).toContain('<table');
    }
  });
});

<<<<<<< HEAD
describe('Now answers from what needs attention', () => {
  const at = '2026-11-18T12:00:00Z';
  const now = Date.parse('2026-11-18T12:00:30Z');
  const cve = (findings: unknown[], kevChecked = true) => ({ checkedAt: at, hosts: 1, packages: 1, advisories: 1, notChecked: [], gaps: [], kevChecked, findings });
  const kev = { id: 'CVE-2026-0001', pkg: 'openssl', host: 'vault', severity: 'high', kev: true, fixed: '3.0.99' };
  test('reports all good only when every source was read and none asks for a step', async () => {
    const { attention, nowView } = await import('../src/views.ts');
    const { data } = parseDashboard({ generatedAt: at, services: [], needs: [], alerts: [], cve: cve([]) });
    expect(attention(data, now)).toEqual([]);
    expect(nowView(data, now)).toContain('Nothing needs you');
    expect(nowView(data, now)).toContain('All clear');
  });
  test('an unread source is unknown, last, and never an all clear', async () => {
    const { attention, nowView } = await import('../src/views.ts');
    const { data } = parseDashboard({ generatedAt: at, services: [], needs: [], alerts: [] });
    const all = attention(data, now);
    expect(all.map((a) => a.state)).toEqual(['unknown']);
    const html = nowView(data, now);
    expect(html).toContain('not an all clear');
    expect(html).not.toContain('All clear');
  });
  test('an exploited CVE is attention on Now and an item on Act', async () => {
    const { attention, actView } = await import('../src/views.ts');
    const { data } = parseDashboard({ generatedAt: at, services: [], needs: [], alerts: [], cve: cve([kev]) });
    const all = attention(data, now);
    expect(all[0]).toMatchObject({ state: 'down', kind: 'CVE', tab: 'act' });
    expect(actView(data, now)).toContain('CVE-2026-0001');
  });
  test('an exploited mark counts for nothing when the exploited list was not read', async () => {
    const { attention } = await import('../src/views.ts');
    const { data } = parseDashboard({ generatedAt: at, services: [], needs: [], alerts: [], cve: cve([kev], false) });
    const all = attention(data, now);
    expect(all.some((a) => a.kind === 'CVE' && a.state === 'down')).toBe(false);
    expect(all.find((a) => a.kind === 'CVE')?.title).toContain('critical or high');
    expect(all.some((a) => a.state === 'unknown' && a.tab === 'health')).toBe(true);
  });
  test('an action card comes before a down alert with no card', async () => {
    const { attention } = await import('../src/views.ts');
    const { data } = parseDashboard({ generatedAt: at, services: [], needs: [{ id: 'n1', title: 'Renew the cert', why: 'It ends in 3 days', step: 'Run the playbook', since: at }], alerts: [{ monitor: 'plex', state: 'down', since: at, triage: 'off' }], cve: cve([]) });
    expect(attention(data, now).map((a) => a.kind)).toEqual(['CARD', 'ALERT']);
  });
});

describe('the Plane cycle detail', () => {
  const base = { generatedAt: '2026-11-18T00:00:00Z', services: [], needs: [], alerts: [] };
  const plane = { checkedAt: '2026-11-18T00:00:00Z', open: 2, needsPedro: 1, inReview: 0, cycle: 'Week', total: 5, done: 3 };
  test('reads the fixture, with the needs-pedro label as a flag', () => {
    const { data, problems } = parseDashboard(fixture);
    expect(problems).toEqual([]);
    expect(data.plane?.detail?.items.length).toBe(11);
    expect(data.plane?.detail?.items.filter((i) => i.needsPedro).length).toBe(data.plane!.needsPedro);
  });
  test('done above total drops the detail, keeps the counts, and says so', () => {
    const { data, problems } = parseDashboard({ ...base, plane: { ...plane, done: 9 } });
    expect(data.plane?.open).toBe(2);
    expect(data.plane?.detail).toBeNull();
    expect(problems.join(' ')).toContain('cycle detail was unreadable');
  });
  test('an item with no name drops the detail', () => {
    const { data } = parseDashboard({ ...base, plane: { ...plane, openItems: [{ seq: 1 }] } });
    expect(data.plane?.detail).toBeNull();
  });
  test('a feed with no detail is not a problem', () => {
    const { data, problems } = parseDashboard({ ...base, plane: { checkedAt: plane.checkedAt, open: 2, needsPedro: 1, inReview: 0 } });
    expect(data.plane?.detail).toBeNull();
    expect(problems.join(' ')).not.toContain('Plane');
  });
});

describe('the demo clock', () => {
  const now = Date.parse('2026-12-01T00:00:00Z');
  test('a live feed is read at the real time', () => expect(clockFor({ source: 'pete-bot', generatedAt: '2026-11-16T22:00:00Z' }, now)).toBe(now));
  test('the fixture is read one minute after it was written', () => expect(clockFor({ source: DEMO_SOURCE, generatedAt: '2026-11-16T22:00:00Z' }, now)).toBe(Date.parse('2026-11-16T22:01:00Z')));
  test('a fixture with a bad time falls back to the real time', () => expect(clockFor({ source: DEMO_SOURCE, generatedAt: 'nope' }, now)).toBe(now));
});

describe('backups', () => {
  const at = '2026-11-18T12:00:00Z';
  const now = Date.parse('2026-11-18T12:00:30Z');
  const base = { generatedAt: at, services: [], needs: [], alerts: [], cve: { checkedAt: at, hosts: 1, packages: 1, advisories: 1, notChecked: [], gaps: [], kevChecked: true, findings: [] } };
  const report = (guests: unknown[], checkedAt = at) => ({ checkedAt, guests });
  test('a guest is in time, late after 36 hours, and missing after 72 hours or with no good run', async () => {
    const { backupState } = await import('../src/model.ts');
    const g = (lastGood: string | null) => ({ guest: 'g', lastGood, detail: '' });
    expect(backupState(g('2026-11-18T06:00:00Z'), now)).toBe('ok');
    expect(backupState(g('2026-11-16T20:00:00Z'), now)).toBe('warn');
    expect(backupState(g('2026-11-15T06:00:00Z'), now)).toBe('down');
    expect(backupState(g(null), now)).toBe('down');
    expect(backupState(g('nope'), now)).toBe('down');
  });
  test('a late backup is an item on Act and a line on Now', async () => {
    const { actItems, nowView } = await import('../src/views.ts');
    const { data } = parseDashboard({ ...base, backups: report([{ guest: 'vault', lastGood: '2026-11-16T20:00:00Z' }, { guest: 'plex', lastGood: '2026-11-18T06:00:00Z' }]) });
    expect(actItems(data, now).map((i) => i.kind)).toEqual(['BACKUP']);
    expect(nowView(data, now)).toContain('vault');
    expect(nowView(data, now)).not.toContain('All clear');
  });
  test('a card that names the guest and its backup stands in for the backup item', async () => {
    const { actItems } = await import('../src/views.ts');
    const { data } = parseDashboard({ ...base, needs: [{ id: 'n1', title: 'Vault backup failed', why: 'w', step: 'Run it again', since: at }], backups: report([{ guest: 'vault', lastGood: null }]) });
    expect(actItems(data, now).map((i) => i.kind)).toEqual(['CARD']);
  });
  test('a feed with no backup report is unknown on Health and does not hold Now at unknown', async () => {
    const { healthView, nowView, tiles } = await import('../src/views.ts');
    const { data, problems } = parseDashboard(base);
    expect(data.backups).toBeNull();
    expect(problems.join(' ')).not.toContain('backup');
    expect(tiles(data, now)).toMatch(/Backups[^]*?Unknown/);
    expect(healthView(data, now)).not.toContain('Backups and patches are in order');
    expect(nowView(data, now)).toContain('All clear');
  });
  test('an out-of-date backup report is unknown on Health and on Now, and raises no item', async () => {
    const { actItems, nowView, tiles } = await import('../src/views.ts');
    const { data } = parseDashboard({ ...base, backups: report([{ guest: 'vault', lastGood: null }], '2026-11-10T00:00:00Z') });
    expect(actItems(data, now)).toEqual([]);
    expect(tiles(data, now)).toMatch(/Backups[^]*?Unknown/);
    expect(nowView(data, now)).toContain('The backup report is out of date');
    expect(nowView(data, now)).not.toContain('All clear');
  });
  test('a malformed backup report is dropped and reported', () => {
    const { data, problems } = parseDashboard({ ...base, backups: { checkedAt: at, guests: [{ lastGood: at }] } });
    expect(data.backups).toBeNull();
    expect(problems.join(' ')).toContain('backup report was unreadable');
  });
  test('Health is steady only when every guest is in time and no finding has a fix', async () => {
    const { healthView } = await import('../src/views.ts');
    const { data } = parseDashboard({ ...base, backups: report([{ guest: 'vault', lastGood: '2026-11-18T06:00:00Z' }]) });
    expect(healthView(data, now)).toContain('Backups and patches are in order');
  });
});

describe('Act', () => {
  const at = '2026-11-18T12:00:00Z';
  const now = Date.parse('2026-11-18T12:00:30Z');
  test('a recovery is not an item, and it stays on record', async () => {
    const { actItems, actView } = await import('../src/views.ts');
    const { data } = parseDashboard({ generatedAt: at, services: [], needs: [], alerts: [{ monitor: 'ollama', state: 'up', since: at, triage: 'no_action' }], cve: { checkedAt: at, hosts: 1, packages: 1, advisories: 1, notChecked: [], gaps: [], kevChecked: true, findings: [] } });
    expect(actItems(data, now)).toEqual([]);
    const html = actView(data, now);
    expect(html).toContain('Nothing to fix');
    expect(html).toContain('ollama');
  });
  test('every item carries a step and a button', async () => {
    const { actItems } = await import('../src/views.ts');
    const { data } = parseDashboard(fixture);
    const items = actItems(data, Date.parse(fixture.generatedAt) + 60_000);
    expect(items.length).toBeGreaterThan(2);
    for (const i of items) {
      expect(i.step.length).toBeGreaterThan(0);
      expect(i.button).toContain('href=');
    }
=======
describe('httpFeed sign-in hint', () => {
  test('sends credentials and names the origin to sign in to when a cross-origin read fails', async () => {
    let init: RequestInit | undefined;
    const f = httpFeed('https://reports.example.test/api/dashboard', null, (async (_u: string, i?: RequestInit) => { init = i; throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch);
    await expect(f.load()).rejects.toThrow('open https://reports.example.test once to sign in');
    expect(init?.credentials).toBe('include');
>>>>>>> origin/main
  });
});
