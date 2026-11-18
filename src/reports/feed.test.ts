import { describe, it, expect } from 'bun:test';
import { buildDashboardFeed } from './feed.js';
import type { AlertBatch } from '../server/alertStore.js';
import type { ReportHub } from './hub.js';

type Row = Record<string, unknown>;
type Feed = { alerts: Row[]; needs: Row[]; services: unknown[]; cve?: Row & { findings: Row[] }; plane?: Row };
const feed = (i: Parameters<typeof buildDashboardFeed>[0]) => buildDashboardFeed(i) as unknown as Feed;
const fakeHub = (recs: Record<string, Row[]>) => ({ list: (k: string) => ({ records: recs[k] ?? [], unreadable: [] }) }) as unknown as ReportHub;

const now = new Date('2026-11-17T12:00:00Z');
const batch = (monitors: AlertBatch['monitors']): AlertBatch => ({ id: 'b1', openedAt: 0, lastAddedAt: 0, monitors });

describe('buildDashboardFeed', () => {
  it('lists open alerts and turns a triage note into a needs row', () => {
    const f = feed({ hub: null, now, batches: [batch({ 'Plex backup': { since: 1_000, checks: 1, note: '**Suggested by the local model (unverified):** Free space is low on pve03\nWhy: the vzdump failed' }, Grafana: { since: 2_000, checks: 1 } })] });
    expect(f.alerts).toHaveLength(2);
    expect(f.needs).toHaveLength(1);
    expect(f.needs[0]!).toMatchObject({ title: 'Plex backup', step: 'Free space is low on pve03', why: 'the vzdump failed' });
    expect(f.alerts.find((a: Row) => a.monitor === 'Grafana')?.triage).toBe('off');
  });

  it('marks a recovered monitor up and leaves it out of needs', () => {
    const f = feed({ hub: null, now, batches: [batch({ X: { since: 1, checks: 1, recoveredAt: 5, note: '**Suggested by the local model (unverified):** step' } })] });
    expect(f.alerts[0]!.state).toBe('up');
    expect(f.needs).toEqual([]);
  });

  it('omits the CVE and Plane sections when there is no hub, rather than sending zeros', () => {
    const f = feed({ hub: null, now, batches: [] });
    expect('cve' in f).toBe(false);
    expect('plane' in f).toBe(false);
    expect(f.services).toEqual([]);
  });

  it('maps the newest CVE and cycle records', () => {
    const hub = fakeHub({
      cve: [{ id: '2026-11-17', generatedAt: 'T1', examined: { hostsRead: 40, hostsUnread: ['pi1'], queries: 900, advisories: 12 }, top: [{ package: 'openssl', fixed: '3.0.2', severity: 'MODERATE', kev: true, hosts: ['h1'], cve: 'CVE-1' }] }],
      cycle: [{ id: '2026-11-17', generatedAt: 'T2', open: 5, needsPedro: 2, inReview: 1 }],
    });
    const f = feed({ hub, now, batches: [] });
    expect(f.cve).toMatchObject({ hosts: 40, packages: 900, notChecked: ['pi1'] });
    expect(f.cve!.findings[0]).toMatchObject({ id: 'CVE-1', pkg: 'openssl', severity: 'medium', host: 'h1', kev: true });
    expect(f.plane).toEqual({ checkedAt: 'T2', open: 5, needsPedro: 2, inReview: 1 });
  });

  it('passes the cycle detail through, and adds none for a record that lacks it', () => {
    const items = [{ seq: 941, name: 'Review the dashboard', state: 'Todo', labels: ['needs-pedro'] }];
    const hub = fakeHub({ cycle: [{ id: 'd', generatedAt: 'T2', open: 5, needsPedro: 2, inReview: 1, inProgress: 2, total: 9, done: 4, lost: 0, cycle: { name: 'Week of 2026-11-16', start: '2026-11-16', end: '2026-11-22' }, byRoute: { pedro: { total: 3, done: 1 }, ai: { total: 5, done: 3 }, other: { total: 1, done: 0 } }, openItems: items }] });
    expect(feed({ hub, now, batches: [] }).plane).toMatchObject({ open: 5, total: 9, done: 4, inProgress: 2, start: '2026-11-16', end: '2026-11-22', byRoute: { pedro: { total: 3, done: 1 } }, openItems: items });
    const old = fakeHub({ cycle: [{ id: 'd', generatedAt: 'T2', open: 5, needsPedro: 2, inReview: 1 }] });
    expect('total' in feed({ hub: old, now, batches: [] }).plane!).toBe(false);
  });

  it('carries the CVE gaps and an unread exploited list instead of reading as clear', () => {
    const hub = fakeHub({ cve: [{ id: 'd', generatedAt: 'T', complete: false, examined: { hostsRead: 3, hostsUnread: [], queries: 9, advisories: 4, kevEntries: 0 }, gaps: ['CISA fetch failed, so nothing is marked as exploited'], top: [] }] });
    const f = feed({ hub, now, batches: [] });
    expect(f.cve).toMatchObject({ kevChecked: false, gaps: ['CISA fetch failed, so nothing is marked as exploited'] });
  });

  it('marks a complete record as examined, and a record with no gap list as unknown', () => {
    const ok = feed({ hub: fakeHub({ cve: [{ id: 'd', generatedAt: 'T', complete: true, exploited: 16, examined: { kevEntries: 1200 }, gaps: [], top: [] }] }), now, batches: [] });
    expect(ok.cve).toMatchObject({ kevChecked: true, gaps: [], exploited: 16 });
    const old = feed({ hub: fakeHub({ cve: [{ id: 'd', generatedAt: 'T', examined: {}, top: [] }] }), now, batches: [] });
    expect(old.cve).toMatchObject({ kevChecked: false });
  });

  it('drops a cycle record that predates the in-review count', () => {
    const hub = fakeHub({ cycle: [{ id: 'x', generatedAt: 'T', open: 3 }] });
    expect('plane' in feed({ hub, now, batches: [] })).toBe(false);
  });
});

describe('buildDashboardFeed: shipped', () => {
  const week = {
    week: '2026-11-09', generatedAt: '2026-11-16T03:00:00Z', total: 12, openNow: 2,
    byRepo: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`r${i}`, 10 - i])),
    byAuthor: { P: 12 },
    merged: Array.from({ length: 12 }, (_, i) => ({ repo: 'r0', number: i + 1, title: `PR ${i + 1}`, url: 'https://github.com/o/r0/pull/1', author: 'P', mergedAt: `2026-11-1${i % 10}T00:00:00Z`, petKeys: [] })),
    coverage: { reposRead: 9, reposTotal: 10, unread: ['x'], floorRepos: [] },
    summary: { source: 'ollama' as const, model: 'm', text: 'A summary.' },
  };
  it('carries a bounded weekly section with no URLs', () => {
    const f = buildDashboardFeed({ hub: null, now, batches: [], week }) as unknown as { shipped: { repos: unknown[]; prs: Row[]; summary: string } };
    expect(f.shipped.repos).toHaveLength(8);
    expect(f.shipped.prs).toHaveLength(10);
    expect(f.shipped.prs[0]).not.toHaveProperty('url');
    expect(f.shipped.summary).toBe('A summary.');
  });
  it('leaves the section out with no stored week, and drops a failed summary', () => {
    expect(buildDashboardFeed({ hub: null, now, batches: [], week: null })).not.toHaveProperty('shipped');
    const f = buildDashboardFeed({ hub: null, now, batches: [], week: { ...week, summary: { source: 'none' as const, text: '', reason: 'down' } } }) as unknown as { shipped: Row };
    expect(f.shipped).not.toHaveProperty('summary');
  });
});
