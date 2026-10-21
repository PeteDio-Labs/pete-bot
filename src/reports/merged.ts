/**
 * Merged PRs per week (PET-737): how many PRs landed in each repo, and who opened them. The
 * week runs Monday to Sunday in Eastern, as the cycle does (workspace#169).
 *
 * ⚠ A COUNT SAYS WHAT IT COVERS. The collector reads the newest-updated closed PRs per repo
 * and stops at a cap. A repo that hit the cap before it reached the start of a week may have
 * merges the read never saw, so that week's count is a floor and the block says so.
 *
 * "Author" is the login that opened the PR, not who decided it. A thread's PR opened through
 * the thread-author App shows as the App, and an older one shows as Pedro.
 */
import { localTime } from './schedule.js';
import type { Snapshot } from './snapshot.js';
import type { ClosedPr, RepoRead } from './collect.js';

/** Known logins, by the name Pedro uses. Any other login shows as itself. */
export const AUTHOR_LABELS: Record<string, string> = {
  petedillo: 'Pedro',
  'petedio-cloud-threads[bot]': 'threads bot',
  'petedio-ops-247[bot]': '247 bot',
  'meta-muse-ai[bot]': 'Muse',
};

const DAY_MS = 86_400_000;

/** The Monday (YYYY-MM-DD) of the Eastern week that holds `at`. */
export function weekStart(at: Date): string {
  const t = localTime(at);
  const d = new Date(`${t.date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((t.weekday + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export interface WeekCount {
  start: string;
  total: number;
  byRepo: Map<string, number>;
  byAuthor: Map<string, number>;
  /** Repos whose read stopped at the cap before it reached this week's start. */
  floorRepos: string[];
}

/** The PRs merged in the Eastern week that starts `start`, counted across the repos that were read. */
export function countWeek(repos: RepoRead[], start: string): WeekCount {
  const week = (p: ClosedPr): boolean => !!p.mergedAt && weekStart(new Date(p.mergedAt)) === start;
  const byRepo = new Map<string, number>();
  const byAuthor = new Map<string, number>();
  const floorRepos: string[] = [];
  let total = 0;
  for (const r of repos) {
    if (!r.ok) continue;
    if (r.closedReachBack && localTime(new Date(r.closedReachBack)).date >= start) floorRepos.push(r.repo);
    for (const p of r.closed.filter(week)) {
      total++;
      byRepo.set(r.repo, (byRepo.get(r.repo) ?? 0) + 1);
      const who = (Object.hasOwn(AUTHOR_LABELS, p.author) ? AUTHOR_LABELS[p.author] : undefined) ?? (p.author || 'unknown');
      byAuthor.set(who, (byAuthor.get(who) ?? 0) + 1);
    }
  }
  return { start, total, byRepo, byAuthor, floorRepos };
}

const tally = (m: Map<string, number>, strip = ''): string =>
  [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${strip ? k.replace(strip, '') : k} ${n}`).join(', ') || 'none';

export function weeklyMergedBlock(s: Snapshot): string[] {
  const read = s.repos.filter((r) => r.ok);
  if (read.length === 0) return ['', '**Merged PRs per week**', '- no repo was read, so nothing is counted'];
  const thisWeek = weekStart(s.at);
  const weeks = [thisWeek, addDays(thisWeek, -7)].map((w) => countWeek(s.repos, w));
  const out: string[] = ['', `**Merged PRs per week** (Monday to Sunday, Eastern; ${read.length} of ${s.repos.length} repos read)`];
  weeks.forEach((w, i) => {
    const unread = s.repos.length - read.length;
    const floorWhy = [
      ...(unread ? [`${unread} repos were not read`] : []),
      ...(w.floorRepos.length ? [`the read of ${w.floorRepos.map((r) => r.replace(/^petedio-/, '')).join(', ')} stopped before this week`] : []),
    ];
    const floor = floorWhy.length ? ` · at least: ${floorWhy.join('; ')}` : '';
    out.push(`- ${i === 0 ? 'This week so far' : 'Last week'} (from ${w.start}): **${w.total}**${floor}`);
    if (w.total > 0) {
      out.push(`  - by repo: ${tally(w.byRepo, 'petedio-')}`);
      out.push(`  - by author: ${tally(w.byAuthor)}`);
    }
  });
  out.push('_Author is the login that opened the PR, not who approved it._');
  return out;
}
