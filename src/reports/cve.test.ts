import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCveReport, buildFindings, buildQueries, compareVersions, cvss3Score, isActionable, orderForFetch, parseSnapshot, runCveCheck, toAdvisory, type InventorySnapshot } from './cve.js';
import { dueReports } from './schedule.js';
import { PlaneHttpError } from './plane.js';
import { upgradeHint as upgradeHintText } from './cve.js';
import { ReportRunner } from './runner.js';
import { loadReportSettings } from './settings.js';

const NOW = new Date('2026-10-27T11:30:00Z');

const snap = (over: Partial<InventorySnapshot> = {}): InventorySnapshot => ({
  generatedAt: '2026-10-27T10:00:00Z',
  hosts: [
    {
      name: 'media-237', ok: true, os: { id: 'debian', version: '12' }, images: [{ ref: 'x/y:1' }], apps: [], malformedLines: 0,
      packages: [{ name: 'libssl3', version: '3.0.1-1', source: 'openssl', sourceVersion: '3.0.1-1' }, { name: 'curl', version: '7.88.0-1' }],
    },
    { name: 'pve02', ok: false, error: 'ssh timeout', packages: [], images: [], apps: [], malformedLines: 0 },
  ],
  ...over,
});

const KEV = { vulnerabilities: [{ cveID: 'CVE-2026-0001' }] };
const VULNS: Record<string, unknown> = {
  'DSA-1': { id: 'DSA-1', aliases: ['CVE-2026-0001'], severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }], summary: 'openssl bug', affected: [{ package: { name: 'openssl', ecosystem: 'Debian:12' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '3.0.2-1' }] }] }] },
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

describe('severity and fixed versions', () => {
  it('scores a CVSS v3 vector', () => {
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:L/A:N')).toBe(7.2);
    expect(cvss3Score('CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N')).toBe(1.8);
    expect(cvss3Score('CVSS:4.0/AV:N')).toBeNull();
    expect(cvss3Score('garbage')).toBeNull();
  });
  it('reads Debian severity from the top-level severity array', () => {
    const a = toAdvisory({ id: 'DEBIAN-CVE-2026-1', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] });
    expect(a.severity).toBe('CRITICAL');
    expect(toAdvisory({ id: 'x', database_specific: { severity: 'low' } }).severity).toBe('LOW');
    expect(toAdvisory({ id: 'y' }).severity).toBe('unrated');
  });
  it('keeps every distinct fixed version of a package', () => {
    const a = toAdvisory({ id: 'z', affected: [{ package: { name: 'p', ecosystem: 'Debian:12' }, ranges: [{ events: [{ fixed: '1.2' }] }, { events: [{ fixed: '2.4' }] }] }] });
    expect(a.fixed.get('Debian:12|p')).toEqual(['1.2', '2.4']);
  });
  it('fetches advisories that name a KEV entry first', () => {
    expect(orderForFetch(['DSA-1', 'DEBIAN-CVE-2026-0001', 'A'], new Set(['CVE-2026-0001']))[0]).toBe('DEBIAN-CVE-2026-0001');
  });
});

describe('collector fields', () => {
  it('queries the Debian source version, not the binary version', () => {
    const h = { ...snap().hosts[0]!, packages: [{ name: 'libssl3', version: '3.0.1-1+b1', source: 'openssl', sourceVersion: '3.0.1-1' }] };
    expect(buildQueries(snap({ hosts: [h] }))[0]).toMatchObject({ name: 'openssl', version: '3.0.1-1' });
  });
  it('treats an empty or non-numeric VERSION_ID as unscanned, not as "Debian:"', async () => {
    for (const version of ['', 'sid']) {
      const h = { ...snap().hosts[0]!, os: { id: 'debian', version } };
      expect(buildQueries(snap({ hosts: [h] }))).toEqual([]);
    }
  });
  it('reads CVE ids from upstream', () => {
    expect(toAdvisory({ id: 'DEBIAN-CVE-9', upstream: ['CVE-2026-0001'] }).cves).toEqual(['CVE-2026-0001']);
  });
  it('reports an image list the collector could not read', async () => {
    const h = { ...snap().hosts[0]!, imagesError: 'daemon down' };
    expect(buildCveReport(await runCveCheck(snap({ hosts: [h] }), NOW, feeds()), '2026-10-27')).toContain('the image list could not be read (daemon down)');
  });
  it('keys a finding on the installed version, so a changed fix does not file it twice', async () => {
    const a = (await runCveCheck(snap(), NOW, feeds())).findings[0]!;
    expect(a.key).toBe('Debian:12|openssl|3.0.1-1|kev');
  });
});

describe('fixed versions', () => {
  it('orders versions like dpkg', () => {
    expect(compareVersions('3.0.9-1', '3.0.2-1')).toBeGreaterThan(0);
    expect(compareVersions('1:1.0-1', '9.9-1')).toBeGreaterThan(0);
    expect(compareVersions('1.0~rc1-1', '1.0-1')).toBeLessThan(0);
    expect(compareVersions('1.10-1', '1.9-1')).toBeGreaterThan(0);
    expect(compareVersions('2.0-1', '2.0-1')).toBe(0);
  });
  const q = { ecosystem: 'Debian:12', name: 'p', version: '1', hosts: new Set(['h']), binaries: new Set(['p']) };
  const adv = (id: string, fixes: string[], cve: string) => toAdvisory({ id, aliases: [cve], affected: fixes.length ? [{ package: { name: 'p', ecosystem: 'Debian:12' }, ranges: [{ events: fixes.map((fixed) => ({ fixed })) }] }] : [] });
  it('names the highest fix, so installing it closes every fixed advisory', () => {
    const f = buildFindings([{ query: q, ids: ['A', 'B'] }], new Map([['A', adv('A', ['3.0.2-1'], 'CVE-2026-1')], ['B', adv('B', ['3.0.9-1'], 'CVE-2026-2')]]), null)[0]!;
    expect(f.fixed).toBe('3.0.9-1');
  });
  it('does not let an unfixed exploited advisory inherit another advisory\'s fix', () => {
    const f = buildFindings([{ query: q, ids: ['A', 'B'] }], new Map([['A', adv('A', ['3.0.2-1'], 'CVE-2026-1')], ['B', adv('B', [], 'CVE-2026-2')]]), new Set(['CVE-2026-2']))[0]!;
    expect(f.kev).toBe(true);
    expect(f.unfixed).toEqual(['B']);
    expect(upgradeHintText(f)).toContain('does not close 1 advisories with no fix (B)');
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
    expect(text).toContain('**KEV CRITICAL**');
    expect(text).toContain('Filing: off');
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
    await expect(runCveCheck(snap({ hosts: [snap().hosts[1]!] }), NOW, feeds())).rejects.toThrow('nothing was examined');
    const ubuntu = snap({ hosts: [{ ...snap().hosts[0]!, os: { id: 'ubuntu', version: '24.04' } }] });
    await expect(runCveCheck(ubuntu, NOW, feeds())).rejects.toThrow('nothing was examined');
    await expect(runCveCheck(snap({ hosts: [] }), NOW, feeds())).rejects.toThrow('lists no hosts');
  });
  it('lists a host with an unsupported OS as unscanned instead of counting it clean', async () => {
    const mixed = snap({ hosts: [snap().hosts[0]!, { ...snap().hosts[0]!, name: 'odd', os: { id: 'alpine', version: '3.20' } }] });
    const text = buildCveReport(await runCveCheck(mixed, NOW, feeds()), '2026-10-27');
    expect(text).toContain('Examined 1 of 2 hosts');
    expect(text).toContain('odd was not scanned: OS "alpine"');
  });
  it('does not count an ok host with no os or no packages as examined', async () => {
    const odd = snap({ hosts: [snap().hosts[0]!, { name: 'noos', ok: true, packages: [{ name: 'a', version: '1' }], images: [], apps: [], malformedLines: 0 }, { name: 'empty', ok: true, os: { id: 'debian', version: '12' }, packages: [], images: [], apps: [], malformedLines: 0 }] });
    const text = buildCveReport(await runCveCheck(odd, NOW, feeds()), '2026-10-27');
    expect(text).toContain('Examined 1 of 3 hosts');
    expect(text).toContain('noos was not scanned');
    expect(text).toContain('empty was not scanned: it listed no installed packages');
  });
  it('reports package lines the collector could not read', async () => {
    const bad = snap({ hosts: [{ ...snap().hosts[0]!, malformedLines: 3 }] });
    expect(buildCveReport(await runCveCheck(bad, NOW, feeds()), '2026-10-27')).toContain('media-237: 3 package lines could not be read');
  });
  it('does not count a host with an unusable VERSION_ID as examined just because it lists an app', async () => {
    const h = { ...snap().hosts[0]!, name: 'odd', os: { id: 'debian', version: '' }, apps: [{ name: 'cloudflared', version: '1.0', ecosystem: 'Go', package: 'github.com/cloudflare/cloudflared' }] };
    const text = buildCveReport(await runCveCheck(snap({ hosts: [snap().hosts[0]!, h] }), NOW, feeds()), '2026-10-27');
    expect(text).toContain('Examined 1 of 2 hosts');
    expect(text).toContain('odd was not scanned');
  });
  it('reports packages that fell back to the binary version', async () => {
    const h = { ...snap().hosts[0]!, packages: [{ name: 'libssl3', version: '3.0.1-1', source: 'openssl' }] };
    expect(buildCveReport(await runCveCheck(snap({ hosts: [h] }), NOW, feeds()), '2026-10-27')).toContain('1 packages had no source version');
  });
  it('flags a snapshot dated in the future', async () => {
    expect(buildCveReport(await runCveCheck(snap({ generatedAt: '2026-10-29T00:00:00Z' }), NOW, feeds()), '2026-10-27')).toContain('in the future');
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
  it('rejects a CVE_FILE_ITEMS value it does not know', () => {
    const base = { REPORTS_MODE: 'on', REPORTS_ENABLED: 'cve', REPORT_REPOS: 'a', CVE_SNAPSHOT_PATH: '/x', DESK_APP_ID: '1', DESK_INSTALLATION_ID: '2', DESK_APP_KEY_PATH: '/k', REPORT_STATE_PATH: '/s' };
    const key = () => '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----';
    expect(loadReportSettings({ ...base, CVE_FILE_ITEMS: 'true' }, key).state).toBe('misconfigured');
    const ok = loadReportSettings({ ...base, CVE_FILE_ITEMS: 'ON' }, key);
    expect(ok.state === 'ready' && ok.settings.cveFileItems).toBe(true);
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
  it('skips findings already filed and still files a later one, up to the cap, and reports the counts', async () => {
    const many = snap({ hosts: [{ ...snap().hosts[0]!, packages: Array.from({ length: 8 }, (_, i) => ({ name: `p${i}`, version: '1', source: 'openssl', sourceVersion: '1' })) }] });
    // Eight versions of one source package give eight distinct findings.
    many.hosts[0]!.packages = many.hosts[0]!.packages.map((p, i) => ({ ...p, version: `1.${i}`, sourceVersion: `1.${i}` }));
    const p = join(mkdtempSync(join(tmpdir(), 'cve-')), 's.json');
    writeFileSync(p, JSON.stringify(many));
    let n = 0;
    const plane = { createItem: async () => (++n <= 2 ? { status: 'exists' as const } : { status: 'created' as const, seq: 900 + n }) } as never;
    const sent: string[] = [];
    const r = new ReportRunner({ settings: base(p, true), github: gh, plane, sender: { send: async (t) => void sent.push(t) }, log, now: () => NOW, feedFetch: feeds() });
    await r.run('cve', { markRun: false });
    const text = sent.join('\n');
    expect(text).toContain('Filing: on');
    expect(text).toContain('already filed 2');
    expect(text).toMatch(/filed PET-\d+/);
    expect(text).toContain('not tried, daily cap of 5 reached');
  });
  it('stops filing at the first Plane error and says how many candidates were not tried', async () => {
    const sent: string[] = [];
    const plane = { createItem: async () => { throw new Error('Plane has no label "lan"'); } } as never;
    const r = new ReportRunner({ settings: base(file(), true), github: gh, plane, sender: { send: async (t) => void sent.push(t) }, log, now: () => NOW, feedFetch: feeds() });
    await r.run('cve', { markRun: false });
    expect(sent.join('\n')).toContain('could not file openssl: Error: Plane has no label "lan"; filing stopped');
    expect(sent.join('\n')).toContain('INCOMPLETE');
  });
  it('retries a failed run in 30 minutes instead of spending the day', async () => {
    const sent: string[] = [];
    let t = new Date('2026-10-27T11:30:00Z');
    const st = join(mkdtempSync(join(tmpdir(), 'cve-')), 'state.json');
    const r = new ReportRunner({ settings: { ...base(file(), false), statePath: st }, github: gh, plane: null, sender: { send: async (x) => void sent.push(x) }, log, now: () => t, feedFetch: feeds({ osvFails: true }) });
    await r.tick();
    expect(sent.length).toBe(1);
    t = new Date(t.getTime() + 60_000);
    await r.tick();
    expect(sent.length).toBe(1);
    t = new Date(t.getTime() + 31 * 60_000);
    await r.tick();
    expect(sent.length).toBe(2);
    t = new Date(t.getTime() + 31 * 60_000);
    await r.tick();
    expect(sent.length).toBe(3);
    t = new Date(t.getTime() + 31 * 60_000);
    await r.tick();
    expect(sent.length).toBe(3);
  });
  it('does not file while the KEV catalog is missing or the snapshot is stale', async () => {
    let called = 0;
    const plane = { createItem: async () => (called++, { status: 'created' as const, seq: 1 }) } as never;
    const sent: string[] = [];
    const r = new ReportRunner({ settings: base(file(), true), github: gh, plane, sender: { send: async (t) => void sent.push(t) }, log, now: () => NOW, feedFetch: feeds({ kevFails: true }) });
    await r.run('cve', { markRun: false });
    expect(called).toBe(0);
    expect(sent.join('\n')).toContain('not filed because the CISA KEV catalog was not read');
    const old = join(mkdtempSync(join(tmpdir(), 'cve-')), 's.json');
    writeFileSync(old, JSON.stringify(snap({ generatedAt: '2026-10-20T00:00:00Z' })));
    const r2 = new ReportRunner({ settings: base(old, true), github: gh, plane, sender: { send: async (t) => void sent.push(t) }, log, now: () => NOW, feedFetch: feeds() });
    await r2.run('cve', { markRun: false });
    expect(called).toBe(0);
    expect(sent.join('\n')).toContain('inventory snapshot is stale');
  });
  it('stops filing on a 401, 403 or 404, which hit every item the same way', async () => {
    const many = snap({ hosts: [{ ...snap().hosts[0]!, packages: Array.from({ length: 3 }, (_, i) => ({ name: `p${i}`, version: `1.${i}`, source: 'openssl', sourceVersion: `1.${i}` })) }] });
    const p = join(mkdtempSync(join(tmpdir(), 'cve-')), 's.json');
    writeFileSync(p, JSON.stringify(many));
    let calls = 0;
    const plane = { createItem: async () => { calls++; throw new PlaneHttpError('x', 401); } } as never;
    const r = new ReportRunner({ settings: base(p, true), github: gh, plane, sender: { send: async () => {} }, log, now: () => NOW, feedFetch: feeds() });
    await r.run('cve', { markRun: false });
    expect(calls).toBe(1);
  });
  it('does not file while advisories could not be read', async () => {
    let called = 0;
    const plane = { createItem: async () => (called++, { status: 'created' as const, seq: 1 }) } as never;
    const sent: string[] = [];
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => (String(url).includes('/v1/vulns/DSA-2') ? new Response('no', { status: 500 }) : feeds()(url, init))) as typeof fetch;
    const r = new ReportRunner({ settings: base(file(), true), github: gh, plane, sender: { send: async (t) => void sent.push(t) }, log, now: () => NOW, feedFetch: flaky });
    await r.run('cve', { markRun: false });
    expect(called).toBe(0);
    expect(sent.join('\n')).toContain('not filed because some advisories were not read');
  });
  it('keeps filing past a 4xx for one finding but stops on a 5xx', async () => {
    const many = snap({ hosts: [{ ...snap().hosts[0]!, packages: Array.from({ length: 3 }, (_, i) => ({ name: `p${i}`, version: `1.${i}`, source: 'openssl', sourceVersion: `1.${i}` })) }] });
    const p = join(mkdtempSync(join(tmpdir(), 'cve-')), 's.json');
    writeFileSync(p, JSON.stringify(many));
    for (const [status, filed] of [[400, 2], [503, 0]] as const) {
      let n = 0;
      const plane = { createItem: async () => { if (++n === 1) throw new PlaneHttpError('x', status); return { status: 'created' as const, seq: 950 + n }; } } as never;
      const sent: string[] = [];
      const r = new ReportRunner({ settings: base(p, true), github: gh, plane, sender: { send: async (t) => void sent.push(t) }, log, now: () => NOW, feedFetch: feeds() });
      await r.run('cve', { markRun: false });
      expect((sent.join('\n').match(/PET-95/g) ?? []).length).toBe(filed);
    }
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
