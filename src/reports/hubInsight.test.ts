import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insightRecord, weekFraction, type InsightInput } from './hubInsight.js';
import { HubJobs } from './hubJobs.js';
import { ReportHub } from './hub.js';
import type { OpenPr, RepoRead } from './collect.js';
import type { PlaneItem } from './plane.js';
import type { WeekRecord } from './weekly.js';

// Saturday 2026-11-07 noon Eastern.
const AT = new Date('2026-11-07T17:00:00Z');
const item = (seq: number, over: Partial<PlaneItem> = {}): PlaneItem => ({ id: `i${seq}`, seq, name: `Item ${seq}`, stateName: 'Todo', stateGroup: 'unstarted', labels: [], parent: null, targetDate: null, updatedAt: '2026-11-06T00:00:00Z', priority: 'none', ...over });
const pr = (n: number, over: Partial<OpenPr> = {}): OpenPr => ({ repo: 'petedio-iac', number: n, title: `PR ${n}`, url: `https://github.com/PeteDio-Labs/petedio-iac/pull/${n}`, draft: false, author: 'x', headSha: 'abc', headRef: 'b', updatedAt: '2026-11-06T00:00:00Z', mergeable: true, petKeys: [], checks: { total: 1, passed: 1, pending: [], failed: [], skipped: 0 } as never, codex: [], gaps: [], ...over });
const repo = (open: OpenPr[]): RepoRead => ({ repo: 'petedio-iac', ok: true, open, closed: [], closedRead: 0 });
const week = (w: string, total: number): WeekRecord => ({ week: w, generatedAt: '', total, byRepo: {}, byAuthor: {}, openNow: 0, merged: [], coverage: { reposRead: 1, reposTotal: 1, unread: [], floorRepos: [] }, summary: { source: 'none', text: '' } });
const base = (over: Partial<InsightInput> = {}): InsightInput => ({
  at: AT,
  reads: [repo([])],
  pet: { ok: true, items: [item(1)] },
  kuma: { ok: true, monitors: [] },
  weeks: [],
  cve: [{ id: '2026-11-07', generatedAt: '', complete: true, actionable: 2, exploited: 0 }],
  planeHistory: [],
  med: { ok: true },
  ...over,
});

describe('insightRecord', () => {
  it('ranks an exploited CVE and a down monitor above routine lines', () => {
    const r = insightRecord(base({ kuma: { ok: true, monitors: [{ name: 'Plex', status: 'down', since: null, message: 'timeout' } as never] }, cve: [{ id: '2026-11-07', generatedAt: '', complete: true, actionable: 3, exploited: 1 }] }));
    const h = r.headlines as { level: string; text: string }[];
    expect(h[0]!.text).toContain('exploited');
    expect(h[1]!.text).toContain('Plex');
  });

  it('puts needs-pedro items and escalated PRs under "needs you" and old open PRs under "stuck"', () => {
    const r = insightRecord(
      base({
        reads: [repo([pr(1, { updatedAt: '2026-11-01T00:00:00Z', checks: { total: 1, passed: 0, pending: [], failed: ['validate'], skipped: 0 } as never }), pr(2)])],
        pet: { ok: true, items: [item(5, { labels: ['needs-pedro'], updatedAt: '2026-11-01T00:00:00Z' }), item(6, { stateName: 'In Review', stateGroup: 'started', updatedAt: '2026-11-01T00:00:00Z' })] },
      }),
    );
    expect((r.needsYou as { key: string }[]).map((x) => x.key)).toEqual(['PET-5']);
    expect((r.stuck as { key: string }[]).map((x) => x.key)).toEqual(['petedio-iac#1', 'PET-6']);
    expect(JSON.stringify(r.stuck)).toContain('CI failing');
  });

  it('says a source was not read and never reports it as zero', () => {
    const r = insightRecord(base({ reads: [{ repo: 'petedio-iac', ok: false, error: 'HTTP 502' }], pet: { ok: false, error: 'HTTP 500' }, med: { ok: false, reason: 'no id' } }));
    expect(r.gaps as string[]).toEqual(expect.arrayContaining([expect.stringContaining('GitHub was not read'), expect.stringContaining('Plane PET board not read'), expect.stringContaining('MED board not read')]));
    expect((r.trends as { label: string; now: number | null }[])[0]!.now).toBeNull();
    expect((r.read as { github: { reposRead: number } }).github.reposRead).toBe(0);
  });

  it('throws when nothing could be read', () => {
    expect(() => insightRecord(base({ reads: [], pet: { ok: false, error: 'x' }, kuma: { ok: false, error: 'y' } }))).toThrow('no source could be read');
  });

  it('judges a part-week count against the 8-week average by pace', () => {
    const weeks = ['2026-11-02', '2026-10-26', '2026-10-19', '2026-10-12'].map((w) => week(w, 10));
    const closed = Array.from({ length: 12 }, (_, k) => ({ repo: 'petedio-iac', number: k, title: 't', url: 'u', headSha: 's', headRef: 'b', closedAt: '', mergedAt: '2026-11-04T15:00:00Z', author: 'x', petKeys: [], codex: null }));
    const r = insightRecord(base({ weeks: weeks.slice(1), reads: [{ repo: 'petedio-iac', ok: true, open: [], closed, closedRead: 12 }] }));
    const t = (r.trends as { label: string; now: number; verdict: string }[])[0]!;
    expect(t.now).toBe(12);
    expect(t.verdict).toBe('higher'); // 12 by ~Saturday noon is a pace near 16 against an average of 10
  });

  it('weekFraction grows through the week and stays in range', () => {
    expect(weekFraction(new Date('2026-11-02T05:00:00Z'))).toBeLessThan(0.1);
    expect(weekFraction(new Date('2026-11-08T23:00:00Z'))).toBeGreaterThan(0.95);
  });
});

describe('HubJobs everyMinutes', () => {
  it('repeats after the interval, waits 10 minutes after a failure, and replaces the record', async () => {
    const hub = new ReportHub(mkdtempSync(join(tmpdir(), 'hubins-')));
    let now = new Date('2026-11-07T12:00:00Z');
    let calls = 0;
    let fail = false;
    const jobs = new HubJobs(hub, [{ kind: 'insight', hour: 0, everyMinutes: 180, collect: async (at) => { calls++; if (fail) throw new Error('down'); return { id: '2026-11-07', generatedAt: at.toISOString(), n: calls }; } }], { info() {}, warn() {} }, () => now);
    await jobs.tick();
    await jobs.tick();
    expect(calls).toBe(1);
    now = new Date('2026-11-07T14:00:00Z');
    await jobs.tick();
    expect(calls).toBe(1);
    now = new Date('2026-11-07T15:01:00Z');
    fail = true;
    await jobs.tick();
    expect(calls).toBe(2);
    now = new Date('2026-11-07T15:05:00Z');
    await jobs.tick();
    expect(calls).toBe(2);
    now = new Date('2026-11-07T15:12:00Z');
    fail = false;
    await jobs.tick();
    expect(calls).toBe(3);
    expect(hub.get('insight', '2026-11-07')!.n).toBe(3);
  });
});
