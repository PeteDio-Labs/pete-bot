import { describe, expect, it } from 'bun:test';
import type { CveRun, Finding } from './cve.js';
import { cveRecord } from './hubCve.js';
import { DASHBOARD_HTML } from './dashboardPage.js';

const finding = (over: Partial<Finding>): Finding => ({
  key: 'k', ecosystem: 'Debian', package: 'openssl', installed: '3.0.1', fixed: '3.0.2', unfixed: [], hosts: ['a', 'b', 'c', 'd', 'e'], binaries: [], advisories: ['DSA-1'], cves: ['CVE-2026-1'],
  kev: false, kevUnfixed: false, kevCves: [], severity: 'HIGH', summary: 's', ...over,
});
const run = (over: Partial<CveRun>): CveRun => ({
  snapshot: { hosts: [] } as never, hostsRead: 12, hostsUnread: [{ name: 'pve02', error: 'timeout' }], queries: 900, uniqueAdvisories: 40, advisoriesFetched: 38,
  advisoryGaps: [], inventoryGaps: ['1 host not read'], kevSize: 1200, kevError: null, truncated: 0, imageCount: 7, findings: [], snapshotAgeHours: 3.04, ...over,
});

describe('cveRecord', () => {
  it('says what a clean run examined', () => {
    const r = cveRecord(run({}), '2026-11-07', new Date('2026-11-07T11:00:00Z'));
    expect(r.id).toBe('2026-11-07');
    expect(r.findings).toBe(0);
    expect(r.complete).toBe(true);
    expect(r.examined).toMatchObject({ hostsRead: 12, hostsUnread: ['pve02'], queries: 900, advisories: 40, kevEntries: 1200, snapshotAgeHours: 3 });
    expect(r.gaps).toEqual(['1 host not read']);
  });
  it('counts by severity, flags exploited ones, and marks a feed gap incomplete', () => {
    const r = cveRecord(
      run({ kevSize: null, kevError: 'HTTP 503', findings: [finding({ kev: true, severity: 'CRITICAL' }), finding({ severity: 'LOW', fixed: null }), finding({ severity: 'HIGH' })] }),
      '2026-11-07',
      new Date('2026-11-07T11:00:00Z'),
    );
    expect(r.complete).toBe(false);
    expect(r.bySeverity).toMatchObject({ CRITICAL: 1, HIGH: 1, LOW: 1 });
    expect(r.exploited).toBe(1);
    expect(r.actionable).toBe(2);
    expect((r.top as { hosts: string[] }[])[0]!.hosts).toHaveLength(4);
    expect(r.gaps as string[]).toContain('CISA KEV not read: HTTP 503');
  });
  it('has a renderer on the page', () => {
    expect(DASHBOARD_HTML).toContain('RENDER.cve=');
  });
});
