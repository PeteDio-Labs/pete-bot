import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCveReport, buildQueries, isActionable, parseSnapshot, runCveCheck, type InventorySnapshot } from './cve.js';
import { dueReports } from './schedule.js';
import { ReportRunner } from './runner.js';
import { loadReportSettings } from './settings.js';

const NOW = new Date('2026-10-27T11:30:00Z');

const snap = (over: Partial<InventorySnapshot> = {}): InventorySnapshot => ({
  generatedAt: '2026-10-27T10:00:00Z',
  hosts: [
    {
      name: 'media-237', ok: true, os: { id: 'debian', version: '12' }, images: [{ ref: 'x/y:1' }], apps: [],
      packages: [{ name: 'libssl3', version: '3.0.1-1', source: 'openssl (3.0.1-1)' }, { name: 'curl', version: '7.88.0-1' }],
    },
    { name: 'pve02', ok: false, error: 'ssh timeout', packages: [], images: [], apps: [] },
  ],
  ...over,
});

const KEV = { vulnerabilities: [{ cveID: 'CVE-2026-0001' }] };
const VULNS: Record<string, unknown> = {
  'DSA-1': { id: 'DSA-1', aliases: ['CVE-2026-0001'], summary: 'openssl bug', affected: [{ package: { name: 'openssl', ecosystem: 'Debian:12' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '3.0.2-1' }] }] }] },
  'DSA-2': { id: 'DSA-2', aliases: ['CVE-2026-0002'], database_specific: { severity: 'LOW' }, affected: [] },
};

function feeds(opts: { kevFails?: boolean; osvFails?: boolean } = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('known_exploited')) return opts.kevFails ? new Response('no', { status: 503 }) : Response.json(KEV);
    if (opts.osvFails) return new Response('no', { status: 500 });
    if (u.endsWith('/v1/querybatch')) {
      const q = JSON.parse(String(init?.body)).queries as { package: { name: string } }[];
      return Response.json({ results: q.map((x) => ({ vulns: x.package.name === 'openssl' ? [{ id: 'DSA-1' }, { id: 'DSA-2' }] : [] })) });
    }
    const id = decodeURIComponent(u.split('/v1/vulns/')[1]!);
    return VULNS[id] ? Response.json(VULNS[id]) : new Response('no', { status: 404 });
  }) as typeof fetch;
}

describe('buildQueries', () => {
  it('matches Debian packages by source name and skips hosts that were not read', () => {
    const qs = buildQueries(snap());
    expect(qs.map((q) => `${q.ecosystem}/${q.name}`).sort()).toEqual(['Debian:12/curl', 'Debian:12/openssl']);
    expect([...qs.find((q) => q.name === 'openssl')!.binaries]).toEqual(['libssl3']);
  });
});

describe('parseSnapshot', () => {
  it('rejects a snapshot that is not JSON or has the wrong shape', () => {
    expect(() => parseSnapshot('nope')).toThrow('not JSON');
    expect(() => parseSnapshot('{"hosts":[]}')).toThrow('wrong shape');
  });
});

describe('runCveCheck', () => {
  it('ranks the exploited finding first and names the fix', async () => {
    const run = await runCveCheck(snap(), NOW, feeds());
    expect(run.findings[0]).toMatchObject({ package: 'openssl', fixed: '3.0.2-1', kev: true });
    expect(isActionable(run.findings[0]!)).toBe(true);
    const text = buildCveReport(run, '2026-10-27');
    expect(text).toContain('apt-get install --only-upgrade libssl3');
    expect(text).toContain('Examined 1 of 2 hosts');
    expect(text).toContain('pve02 was not scanned: ssh timeout');
    expect(text).toContain('INCOMPLETE');
  });
  it('says what it examined when it finds nothing, and is not marked incomplete', async () => {
    const clean = snap({ hosts: [{ ...snap().hosts[0]!, packages: [{ name: 'curl', version: '7.88.0-1' }] }] });
    const text = buildCveReport(await runCveCheck(clean, NOW, feeds()), '2026-10-27');
    expect(text).toContain('Examined 1 of 1 hosts, 1 package versions, 0 advisories');
    expect(text).not.toContain('INCOMPLETE');
  });
  it('marks the report incomplete when the KEV feed fails, but still reports', async () => {
    const text = buildCveReport(await runCveCheck(snap(), NOW, feeds({ kevFails: true })), '2026-10-27');
    expect(text).toContain('CISA KEV: HTTP 503, so nothing is marked as exploited');
  });
  it('throws when OSV fails, so the runner sends a failure DM', async () => {
    await expect(runCveCheck(snap(), NOW, feeds({ osvFails: true }))).rejects.toThrow('OSV querybatch: HTTP 500');
  });
  it('throws when no host was read', async () => {
    await expect(runCveCheck(snap({ hosts: [snap().hosts[1]!] }), NOW, feeds())).rejects.toThrow('read none of the hosts');
    await expect(runCveCheck(snap({ hosts: [] }), NOW, feeds())).rejects.toThrow('lists no hosts');
  });
  it('flags a stale inventory', async () => {
    const text = buildCveReport(await runCveCheck(snap({ generatedAt: '2026-10-20T00:00:00Z' }), NOW, feeds()), '2026-10-27');
    expect(text).toContain('hours old');
  });
});

describe('schedule and settings', () => {
  it('runs the cve report on school days, when the other reports stay quiet', () => {
    const all = new Set(['morning', 'cve'] as const);
    expect(dueReports(new Date('2026-10-21T12:00:00Z'), {}, all)).toEqual(['cve']);
  });
  it('refuses to start the cve report with no snapshot path', () => {
    const r = loadReportSettings({ REPORTS_MODE: 'on', REPORTS_ENABLED: 'cve', REPORT_REPOS: 'a' });
    expect(r.state).toBe('misconfigured');
  });
});

describe('ReportRunner cve', () => {
  const log = { info() {}, warn() {}, error() {} };
  const base = (snapshotPath: string, fileItems: boolean) => ({
    org: 'o', repos: ['r'], appId: '1', installationId: '2', privateKeyPem: 'x', plane: null,
    enabled: new Set(['cve'] as const), staleDays: 3, statePath: join(tmpdir(), `st-${Math.random()}.json`), vaultPath: '', cveSnapshotPath: snapshotPath, cveFileItems: fileItems,
  });
  const file = (): string => {
    const p = join(mkdtempSync(join(tmpdir(), 'cve-')), 's.json');
    writeFileSync(p, JSON.stringify(snap()));
    return p;
  };
  const gh = {} as never;

  it('files one item per actionable finding and reports it', async () => {
    const created: { externalId: string }[] = [];
    const sent: string[] = [];
    const plane = { createItem: async (i: { externalId: string }) => (created.push(i), { status: 'created' as const, seq: 801 }) } as never;
    const r = new ReportRunner({ settings: base(file(), true), github: gh, plane, sender: { send: async (t) => void sent.push(t) }, log, now: () => NOW, feedFetch: feeds() });
    await r.run('cve', { markRun: false });
    expect(created.length).toBe(1);
    expect(created[0]!.externalId).toContain('openssl');
    expect(sent.join('\n')).toContain('PET-801');
  });
  it('files nothing when filing is off', async () => {
    let called = false;
    const plane = { createItem: async () => { called = true; return { status: 'created' as const }; } } as never;
    const r = new ReportRunner({ settings: base(file(), false), github: gh, plane, sender: { send: async () => {} }, log, now: () => NOW, feedFetch: feeds() });
    await r.run('cve', { markRun: false });
    expect(called).toBe(false);
  });
  it('sends a failure DM when the snapshot is missing', async () => {
    const sent: string[] = [];
    const r = new ReportRunner({ settings: base('/nonexistent/s.json', false), github: gh, plane: null, sender: { send: async (t) => void sent.push(t) }, log, now: () => NOW, feedFetch: feeds() });
    await r.run('cve', { markRun: false });
    expect(sent[0]).toContain('cve report failed');
    expect(r.status().last.cve).toMatchObject({ ok: false });
  });
});
