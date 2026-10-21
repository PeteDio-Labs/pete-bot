import { describe, expect, it } from 'bun:test';
import { countWeek, weekStart, weeklyMergedBlock } from './merged.js';
import type { ClosedPr, RepoRead } from './collect.js';
import type { Snapshot } from './snapshot.js';

const closed = (n: number, mergedAt: string | null, author = 'petedillo'): ClosedPr => ({
  repo: 'r', number: n, title: 't', url: 'u', headSha: 'a'.repeat(40), headRef: 'x', closedAt: mergedAt ?? '2026-10-01T00:00:00Z', mergedAt, author, petKeys: [], codex: null,
});
const repo = (name: string, closedPrs: ClosedPr[], extra: Partial<Extract<RepoRead, { ok: true }>> = {}): RepoRead => ({ repo: name, ok: true, open: [], closed: closedPrs, closedRead: closedPrs.length, ...extra });
const snap = (repos: RepoRead[]): Snapshot => ({ at: new Date('2026-10-26T11:52:00Z'), repos, plane: { ok: false, error: 'x' } });

describe('weekStart', () => {
  it('uses the Eastern Monday, so a Sunday evening merge belongs to the week that ends', () => {
    expect(weekStart(new Date('2026-10-26T11:52:00Z'))).toBe('2026-10-26');
    expect(weekStart(new Date('2026-10-26T03:30:00Z'))).toBe('2026-10-19');
    expect(weekStart(new Date('2026-10-21T05:00:00Z'))).toBe('2026-10-19');
  });
});

describe('countWeek', () => {
  it('counts merged PRs only, by repo and by author label', () => {
    const w = countWeek(
      [
        repo('petedio-iac', [closed(1, '2026-10-20T12:00:00Z'), closed(2, null), closed(3, '2026-10-21T12:00:00Z', 'petedio-cloud-threads[bot]'), closed(4, '2026-10-14T12:00:00Z')]),
        repo('pete-bot', [closed(5, '2026-10-22T12:00:00Z', 'someone')]),
      ],
      '2026-10-19',
    );
    expect(w.total).toBe(3);
    expect(Object.fromEntries(w.byRepo)).toEqual({ 'petedio-iac': 2, 'pete-bot': 1 });
    expect(Object.fromEntries(w.byAuthor)).toEqual({ Pedro: 1, 'threads bot': 1, someone: 1 });
  });
  it('names meta-muse-ai[bot] Bobberto, and treats an inherited key as an unknown login', () => {
    const w = countWeek([repo('r', [closed(1, '2026-10-20T12:00:00Z', 'meta-muse-ai[bot]'), closed(2, '2026-10-20T12:00:00Z', 'constructor')])], '2026-10-19');
    expect(Object.fromEntries(w.byAuthor)).toEqual({ Bobberto: 1, constructor: 1 });
  });
  it('marks a repo whose read was cut off inside the week as a floor', () => {
    const w = countWeek([repo('petedio-iac', [], { closedReachBack: '2026-10-21T00:00:00Z' })], '2026-10-19');
    expect(w.floorRepos).toEqual(['petedio-iac']);
    expect(countWeek([repo('petedio-iac', [], { closedReachBack: '2026-10-10T00:00:00Z' })], '2026-10-19').floorRepos).toEqual([]);
    // A read that stops on the Monday itself may have missed that day's merges.
    expect(countWeek([repo('petedio-iac', [], { closedReachBack: '2026-10-19T14:00:00Z' })], '2026-10-19').floorRepos).toEqual(['petedio-iac']);
  });
});

describe('weeklyMergedBlock', () => {
  it('says what it read, and shows this week and last week', () => {
    const out = weeklyMergedBlock(snap([repo('petedio-iac', [closed(1, '2026-10-26T12:00:00Z'), closed(2, '2026-10-20T12:00:00Z')])])).join('\n');
    expect(out).toContain('1 of 1 repos read');
    expect(out).toContain('This week so far (from 2026-10-26): **1**');
    expect(out).toContain('Last week (from 2026-10-19): **1**');
  });
  it('says the total is a floor when a repo was not read', () => {
    const out = weeklyMergedBlock(snap([repo('petedio-iac', [closed(1, '2026-10-26T12:00:00Z')]), { repo: 'x', ok: false, error: 'HTTP 404' }])).join('\n');
    expect(out).toContain('at least: 1 repos were not read');
  });
  it('does not report a zero when no repo was read', () => {
    const out = weeklyMergedBlock(snap([{ repo: 'r', ok: false, error: 'HTTP 404' }])).join('\n');
    expect(out).toContain('nothing is counted');
    expect(out).not.toContain('**0**');
  });
});
