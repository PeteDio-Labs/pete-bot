/**
 * Reads GitHub for the reports (PET-701), and records what it could not read.
 *
 * ⚠ SAY WHAT WAS READ. Every repository comes back as `ok` with its counts, or as an error.
 * A repository that answered 404 is "not read", never "no open PRs". PET-298, 317, 360, 363,
 * 372 and 374 are one failure shape: a job that checked nothing and reported success.
 */
import { codexReviews, type CodexReview } from '../desk/codex.js';
import type { CheckSummary, PullDetail, Review } from '../desk/github.js';

/** The slice of GitHubApp the reports use. Tests pass a fake. */
export interface GithubReads {
  get<T>(what: string, path: string): Promise<T>;
  getPull(repo: string, n: number): Promise<PullDetail>;
  listReviews(repo: string, n: number): Promise<Review[]>;
  checks(repo: string, sha: string): Promise<CheckSummary>;
}

export interface OpenPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  author: string;
  headSha: string;
  headRef: string;
  updatedAt: string;
  mergeable: boolean | null;
  petKeys: number[];
  checks: CheckSummary | null;
  codex: CodexReview[] | null;
  /** What failed to read for this PR. Empty when everything did. */
  gaps: string[];
}

export interface ClosedPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
  headRef: string;
  closedAt: string;
  mergedAt: string | null;
  /** The login that opened the PR. */
  author: string;
  petKeys: number[];
  /** Codex reviews, read only for PRs merged inside the window. */
  codex: CodexReview[] | null;
}

export type RepoRead =
  | { repo: string; ok: true; open: OpenPr[]; closed: ClosedPr[]; closedRead: number; closedReachBack?: string }
  | { repo: string; ok: false; error: string };

interface RawPr {
  number: number;
  title: string;
  html_url: string;
  draft?: boolean;
  user: { login: string } | null;
  head: { sha: string; ref: string };
  updated_at: string;
  closed_at?: string | null;
  merged_at?: string | null;
}

export function petKeys(...texts: string[]): number[] {
  const out = new Set<number>();
  for (const t of texts) {
    for (const m of t.matchAll(/\bPET-(\d{1,5})\b/gi)) out.add(Number(m[1]));
    const branch = /^pet-(\d{1,5})(?:-|$)/i.exec(t);
    if (branch) out.add(Number(branch[1]));
  }
  return [...out].sort((a, b) => a - b);
}

const DAY_MS = 86_400_000;
const CLOSED_PAGES = 2;

async function guarded<T>(gaps: string[], what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    gaps.push(`${what}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160));
    return null;
  }
}

async function pagedPrs(gh: GithubReads, repo: string, org: string, query: string, maxPages: number): Promise<RawPr[]> {
  const out: RawPr[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await gh.get<RawPr[]>(`listing ${repo} PRs`, `/repos/${org}/${repo}/pulls?${query}&per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
  return out;
}

export async function collectRepo(
  gh: GithubReads,
  org: string,
  repo: string,
  now: Date,
  opts: { mergedWindowDays: number } = { mergedWindowDays: 14 },
): Promise<RepoRead> {
  try {
    const rawOpen = await pagedPrs(gh, repo, org, 'state=open', 30);
    const open: OpenPr[] = [];
    for (const r of rawOpen) {
      const gaps: string[] = [];
      const detail = await guarded(gaps, 'mergeability', () => gh.getPull(repo, r.number));
      const checks = await guarded(gaps, 'checks', () => gh.checks(repo, r.head.sha));
      const reviews = await guarded(gaps, 'reviews', () => gh.listReviews(repo, r.number));
      open.push({
        repo,
        number: r.number,
        title: r.title,
        url: r.html_url,
        draft: Boolean(r.draft),
        author: r.user?.login ?? '',
        headSha: r.head.sha,
        headRef: r.head.ref,
        updatedAt: r.updated_at,
        mergeable: detail ? detail.mergeable : null,
        petKeys: petKeys(r.title, r.head.ref),
        checks,
        codex: reviews ? codexReviews(reviews) : null,
        gaps,
      });
    }
    // Two pages of the most recently updated closed PRs: up to 200, newest first.
    const rawClosed = await pagedPrs(gh, repo, org, 'state=closed&sort=updated&direction=desc', CLOSED_PAGES);
    const cutoff = now.getTime() - opts.mergedWindowDays * DAY_MS;
    const closed: ClosedPr[] = [];
    for (const r of rawClosed) {
      const merged = r.merged_at ? Date.parse(r.merged_at) : NaN;
      let codex: CodexReview[] | null = null;
      if (Number.isFinite(merged) && merged >= cutoff) {
        codex = await guarded([], 'reviews', async () => codexReviews(await gh.listReviews(repo, r.number)));
      }
      closed.push({
        repo,
        number: r.number,
        title: r.title,
        url: r.html_url,
        headSha: r.head.sha,
        headRef: r.head.ref,
        closedAt: r.closed_at ?? '',
        mergedAt: r.merged_at ?? null,
        author: r.user?.login ?? '',
        petKeys: petKeys(r.title, r.head.ref),
        codex,
      });
    }
    // The listing is newest-updated first and capped. When it hit the cap, a PR merged before the
    // oldest `updated_at` read may be missing, so a count that reaches back that far is a floor.
    const capped = rawClosed.length >= CLOSED_PAGES * 100;
    const reachBack = capped ? rawClosed[rawClosed.length - 1]?.updated_at : undefined;
    return { repo, ok: true, open, closed, closedRead: rawClosed.length, ...(reachBack ? { closedReachBack: reachBack } : {}) };
  } catch (err) {
    return { repo, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}

export async function collectGithub(gh: GithubReads, org: string, repos: string[], now: Date): Promise<RepoRead[]> {
  const out: RepoRead[] = [];
  for (const repo of repos) out.push(await collectRepo(gh, org, repo, now));
  return out;
}
