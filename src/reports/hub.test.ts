import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { openReportDb } from './db.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardApp } from './dashboard.js';
import { DASHBOARD_HTML } from './dashboardPage.js';
import { ReportHub } from './hub.js';
import { WeekStore } from './weekly.js';

let dir = '';
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
const rec = (id: string, extra: Record<string, unknown> = {}) => ({ id, generatedAt: '2026-11-07T00:00:00Z', ...extra });

describe('ReportHub', () => {
  it('stores records per kind and lists them newest first', () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-'));
    const hub = new ReportHub(dir);
    expect(hub.kinds()).toEqual([]);
    hub.save('cve', rec('2026-11-06', { findings: 2 }));
    hub.save('cve', rec('2026-11-07', { findings: 0 }));
    hub.save('cycle', rec('2026-11-07'));
    expect(hub.kinds()).toEqual([{ kind: 'cve', count: 2, newest: '2026-11-07' }, { kind: 'cycle', count: 1, newest: '2026-11-07' }]);
    expect(hub.list('cve').records.map((r) => r.id)).toEqual(['2026-11-07', '2026-11-06']);
    expect(hub.has('cve', '2026-11-06')).toBe(true);
    expect(hub.list('nothing')).toEqual({ records: [], unreadable: [] });
  });
  it('refuses a kind or id that could leave the folder, and names an unreadable file', () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-'));
    const hub = new ReportHub(dir);
    expect(() => hub.save('../x', rec('2026-11-07'))).toThrow('bad report kind');
    expect(() => hub.save('cve', rec('../x'))).toThrow('bad record id');
    hub.save('cve', rec('2026-11-07'));
    openReportDb(dir).query('INSERT INTO hub (kind, id, body) VALUES (?, ?, ?)').run('cve', '2026-11-08', '{bad');
    expect(hub.list('cve')).toEqual({ records: [rec('2026-11-07')], unreadable: ['2026-11-08'] });
  });
  it('does not disturb the weekly store that shares the directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'hub-'));
    const hub = new ReportHub(dir);
    hub.save('cve', rec('2026-11-07'));
    expect(new WeekStore(dir).weeks()).toEqual([]);
  });
});

describe('hub routes', () => {
  async function get(path: string, allowed: boolean, withHub = true) {
    dir = mkdtempSync(join(tmpdir(), 'hub-'));
    const hub = new ReportHub(dir);
    hub.save('cve', rec('2026-11-07', { findings: 1 }));
    const app = createDashboardApp({ store: new WeekStore(dir), hub: withHub ? hub : undefined, verify: async () => (allowed ? { ok: true, email: 'p@x.dev' } : { ok: false, reason: 'no header' }) });
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`);
      return { status: res.status, text: await res.text() };
    } finally {
      server.close();
    }
  }
  it('checks the JWT on both feeds', async () => {
    expect((await get('/api/reports', false)).status).toBe(403);
    expect((await get('/api/reports/cve', false)).status).toBe(403);
  });
  it('lists the kinds and one kind\'s records', async () => {
    expect(JSON.parse((await get('/api/reports', true)).text).kinds[0].kind).toBe('cve');
    expect(JSON.parse((await get('/api/reports/cve', true)).text).records[0].findings).toBe(1);
  });
  it('answers 404 for a bad kind, and an empty list without a hub', async () => {
    expect((await get('/api/reports/..%2Fx', true)).status).toBe(404);
    expect((await get('/api/reports/cve', true, false)).status).toBe(404);
    expect(JSON.parse((await get('/api/reports', true, false)).text).kinds).toEqual([]);
  });
  it('the page has tabs and sets values with textContent only', () => {
    expect(DASHBOARD_HTML).toContain('id="tabs"');
    expect(DASHBOARD_HTML).not.toContain('innerHTML');
  });
});
