import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './ledger.js';
import { ReportHub } from './hub.js';
import { buildDashboardFeed } from './feed.js';
import { readBackups } from '../lab/tools/proxmox.js';
import { readBackups as readBackupsHttp, cachedBackups } from '../failover/backups.js';

const since = Date.parse('2026-11-24T10:00:00Z');
const batch = (note?: string) => ({ id: 'b1', openedAt: since, lastAddedAt: since, monitors: { plex: { since, checks: 1, ...(note ? { note } : {}) } } });

describe('ledger', () => {
  it('counts one open incident once and upgrades it when a card arrives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const l = new Ledger(dir);
    const now = new Date('2026-11-24T12:00:00Z');
    expect(l.observe(now, [batch()], []).incidents).toBe(1);
    expect(l.observe(now, [batch()], []).incidents).toBe(0);
    l.observe(now, [batch('Step: restart. Why: hung.')], []);
    expect(l.triage(now)).toEqual({ read: 1, cards: 1, plain: 0, failures: 0, since: '2026-11-24' });
    expect((l.history(now, null) as { alerts: unknown[] }).alerts).toEqual([{ day: '2026-11-24', act: 1, noAction: 0, unreadable: 0 }]);
  });

  it('writes one uptime cell per half hour and survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const l = new Ledger(dir);
    const svc = { name: 'plex', lab: { ok: true, checkedAt: 'x', detail: '' } };
    l.observe(new Date('2026-11-24T12:00:00Z'), [], [svc]);
    expect(l.observe(new Date('2026-11-24T12:10:00Z'), [], [svc]).cells).toBe(0);
    expect(l.observe(new Date('2026-11-24T12:40:00Z'), [], [{ name: 'plex', lab: null }]).cells).toBe(1);
    const again = new Ledger(dir);
    const h = again.history(new Date(), null) as { uptime: Record<string, { state: string }[]> };
    expect(h.uptime.plex!.map((c) => c.state)).toEqual(['ok', 'unknown']);
  });

  it('reports an unreadable file and starts over instead of reading it as zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    writeFileSync(join(dir, 'dashboard-ledger.json'), '{nope');
    const errs: string[] = [];
    const l = new Ledger(dir, (m) => errs.push(m));
    expect(l.history(new Date(), null)).toBeNull();
    expect(errs[0]).toContain('could not be read');
  });

});

const guests = async () => [{ vmid: 101, name: 'plex' }, { vmid: 102, name: 'vault' }] as never;
const fake = (answers: Record<string, unknown>) => ({
  guests,
  get: async (path: string) => {
    if (path in answers) { const a = answers[path]; if (a instanceof Error) throw a; return a as never; }
    throw new Error(`unexpected ${path}`);
  },
});

describe('readBackups', () => {
  const storages = [{ storage: 'pbs', node: 'pve03', content: 'backup', shared: 1 }, { storage: 'local', node: 'pve03', content: 'iso,vztmpl' }];
  it('takes the newest copy per guest and says when a guest has none', async () => {
    const r = await readBackups(fake({ '/cluster/resources?type=storage': storages, '/nodes/pve03/storage/pbs/content?content=backup': [{ vmid: 101, ctime: 100 }, { vmid: 101, ctime: 300 }] }) as never, new Date('2026-11-25T00:00:00Z'));
    expect(r.guests[0]).toMatchObject({ guest: 'plex', lastGood: new Date(300_000).toISOString() });
    expect(r.guests[1]!.lastGood).toBeNull();
    expect(r.guests[1]!.detail).toContain('No backup copy was found');
  });
  it('names a storage it could not read and fails when none could be', async () => {
    const two = [...storages, { storage: 'nas', node: 'pve02', content: 'backup' }];
    const part = await readBackups(fake({ '/cluster/resources?type=storage': two, '/nodes/pve03/storage/pbs/content?content=backup': [{ vmid: 101, ctime: 5 }], '/nodes/pve02/storage/nas/content?content=backup': new Error('HTTP 500') }) as never);
    expect(part.guests[1]!.detail).toContain('Storage not read: nas');
    await expect(readBackups(fake({ '/cluster/resources?type=storage': storages, '/nodes/pve03/storage/pbs/content?content=backup': new Error('down') }) as never)).rejects.toThrow('every backup storage failed');
    await expect(readBackups(fake({ '/cluster/resources?type=storage': [] }) as never)).rejects.toThrow('no storage that holds backups');
  });
});

describe('backups reader', () => {
  const ok = (body: unknown) => (async () => ({ ok: true, status: 200, json: async () => body })) as never;
  it('returns null on a failed read and says why', async () => {
    const logs: string[] = [];
    const read = cachedBackups('http://x', 't', (m) => logs.push(m), (async () => ({ ok: false, status: 502, json: async () => ({}) })) as never);
    expect(await read(new Date())).toBeNull();
    expect(logs[0]).toContain('HTTP 502');
    expect((await readBackupsHttp('http://x', '', ok({}))).ok).toBe(false);
    expect((await readBackupsHttp('http://x', 't', ok({ checkedAt: 'a', guests: [] }))).ok).toBe(true);
  });
});

describe('feed', () => {
  it('carries the ledger and backup sections, and CVE days from the hub', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const hub = new ReportHub(dir);
    hub.save('cve', { id: '2026-11-23', generatedAt: '2026-11-23T06:00:00Z', bySeverity: { CRITICAL: 1, HIGH: 2, MODERATE: 3, LOW: 4, unrated: 9 } });
    const l = new Ledger(dir);
    const now = new Date('2026-11-24T12:00:00Z');
    l.observe(now, [batch()], [{ name: 'plex', lab: { ok: true, checkedAt: now.toISOString(), detail: '' } }]);
    const backups = { checkedAt: now.toISOString(), guests: [{ guest: 'plex', lastGood: now.toISOString(), detail: '' }] };
    const feed = buildDashboardFeed({ hub, batches: [], now, services: [], backups, history: l.history(now, hub), triage: l.triage(now) });
    expect((feed.history as { cve: unknown[] }).cve).toEqual([{ day: '2026-11-23', critical: 1, high: 2, medium: 3, low: 4 }]);
    expect(feed.backups).toEqual(backups);
    expect((feed.triage as { read: number }).read).toBe(1);
    expect(buildDashboardFeed({ hub: null, batches: [], now, services: [] }).backups).toBeUndefined();
  });
});
