import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_KEY, loadBackupConfig, ReportBackup, type BackupTarget } from './backup.js';
import { openReportDb } from './db.js';
import { ReportHub } from './hub.js';
import { WeekStore, type WeekRecord } from './weekly.js';

const week = (w: string): WeekRecord => ({ week: w, generatedAt: '', total: 1, byRepo: {}, byAuthor: {}, openNow: 0, merged: [], coverage: { reposRead: 1, reposTotal: 1, unread: [], floorRepos: [] }, summary: { source: 'none', text: '' } });
const logger = { info() {}, warn() {}, error() {} };

describe('reports database', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('imports the earlier JSON files once, bad ones included, and leaves the files', () => {
    dir = mkdtempSync(join(tmpdir(), 'db-'));
    writeFileSync(join(dir, '2026-10-26.json'), JSON.stringify(week('2026-10-26')));
    writeFileSync(join(dir, '2026-11-02.json'), '{bad');
    mkdirSync(join(dir, 'reports', 'cve'), { recursive: true });
    writeFileSync(join(dir, 'reports', 'cve', '2026-11-07.json'), JSON.stringify({ id: '2026-11-07', generatedAt: 'x', findings: 3 }));
    const store = new WeekStore(dir);
    expect(store.all().weeks.map((w) => w.week)).toEqual(['2026-10-26']);
    expect(store.all().unreadable).toEqual(['2026-11-02']);
    expect(new ReportHub(dir).get('cve', '2026-11-07')?.findings).toBe(3);
    // A file added after the import is not read: the database is the only store.
    writeFileSync(join(dir, '2026-11-09.json'), JSON.stringify(week('2026-11-09')));
    expect(store.weeks()).toEqual(['2026-11-02', '2026-10-26']);
  });

  it('upserts a record and lists kinds with counts', () => {
    dir = mkdtempSync(join(tmpdir(), 'db-'));
    const hub = new ReportHub(dir);
    hub.save('cve', { id: '2026-11-07', generatedAt: 'a' });
    hub.save('cve', { id: '2026-11-07', generatedAt: 'b' });
    hub.save('cycle', { id: '2026-11-07', generatedAt: 'c' });
    expect(hub.kinds()).toEqual([{ kind: 'cve', count: 1, newest: '2026-11-07' }, { kind: 'cycle', count: 1, newest: '2026-11-07' }]);
    expect(hub.get('cve', '2026-11-07')?.generatedAt).toBe('b');
  });
});

describe('report backup', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('sets all four backup settings or none, and says which is missing', () => {
    expect(loadBackupConfig({}).state).toBe('off');
    const r = loadBackupConfig({ REPORT_BACKUP_ENDPOINT: 'http://h:9000', REPORT_BACKUP_BUCKET: 'pete-bot' });
    expect(r).toMatchObject({ state: 'misconfigured' });
    expect((r as { reason: string }).reason).toContain('REPORT_BACKUP_ACCESS_KEY');
    expect(loadBackupConfig({ REPORT_BACKUP_ENDPOINT: 'h:9000', REPORT_BACKUP_BUCKET: 'pete-bot', REPORT_BACKUP_ACCESS_KEY: 'a', REPORT_BACKUP_SECRET_KEY: 's' }).state).toBe('misconfigured');
    expect(loadBackupConfig({ REPORT_BACKUP_ENDPOINT: 'http://h:9000/', REPORT_BACKUP_BUCKET: 'pete-bot', REPORT_BACKUP_ACCESS_KEY: 'a', REPORT_BACKUP_SECRET_KEY: 's' })).toMatchObject({ state: 'ready', settings: { endpoint: 'http://h:9000' } });
  });

  it('copies a snapshot that opens as the same data, and reports never, ok and failing apart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-'));
    new WeekStore(dir).save(week('2026-11-02'));
    const db = openReportDb(dir);
    const puts: { key: string; body: Uint8Array }[] = [];
    let fail = false;
    const target: BackupTarget = {
      async put(key, body) {
        if (fail) throw new Error('403 AccessDenied');
        puts.push({ key, body });
      },
    };
    let t = Date.parse('2026-11-07T10:00:00Z');
    const b = new ReportBackup(db, target, logger, () => new Date(t));
    expect(b.state()).toEqual({ state: 'never' });
    expect(b.due()).toBe(true);
    expect(await b.run()).toBe(true);
    expect(b.state()).toMatchObject({ state: 'ok', at: '2026-11-07T10:00:00.000Z' });
    expect(puts[0]!.key).toBe(BACKUP_KEY);
    const copy = Database.deserialize(puts[0]!.body);
    expect((copy.query('SELECT week FROM weeks').all() as { week: string }[]).map((r) => r.week)).toEqual(['2026-11-02']);
    expect(b.due()).toBe(false);
    t += 25 * 3600_000;
    expect(b.due()).toBe(true);
    fail = true;
    expect(await b.run()).toBe(false);
    const s = b.state();
    expect(s).toMatchObject({ state: 'failing', lastOk: '2026-11-07T10:00:00.000Z' });
    expect((s as { detail: string }).detail).toContain('AccessDenied');
    fail = false;
    expect(await b.run()).toBe(true);
    expect(b.state().state).toBe('ok');
    // A failure survives a restart, and a copy that stops running reads stale.
    fail = true;
    t += 25 * 3600_000;
    await b.run();
    expect(new ReportBackup(db, target, logger, () => new Date(t)).state().state).toBe('failing');
    fail = false;
    await b.run();
    t += 40 * 3600_000;
    expect(b.state()).toMatchObject({ state: 'stale', hours: 40 });
  });
  it('drops a URL from a failure message', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bk-'));
    const db = openReportDb(dir);
    const b = new ReportBackup(db, { async put() { throw new Error('connect ECONNREFUSED http://192.168.50.245:9000/pete-bot/reports.sqlite'); } }, logger);
    await b.run();
    expect((b.state() as { detail: string }).detail).toBe('connect ECONNREFUSED <url>');
  });
});
