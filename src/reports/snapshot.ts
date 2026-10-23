/**
 * What one report run read, and the helpers all three reports share (PET-701).
 */
import type { CodexReview } from '../desk/codex.js';
import type { CheckSummary } from '../desk/github.js';
import type { OpenPr, RepoRead } from './collect.js';
import type { CycleRead, PlaneItem, PlaneRead } from './plane.js';

export interface Snapshot {
  at: Date;
  repos: RepoRead[];
  plane: PlaneRead;
  /** Read only for the morning queue. `undefined` means the report does not show cycles. */
  cycles?: CycleRead;
}

export const PLANE_BROWSE = 'https://plane.pdlab.dev/petedio/browse';
const CLOSED_GROUPS = new Set(['completed', 'cancelled']);

export const isOpenItem = (i: PlaneItem): boolean => !CLOSED_GROUPS.has(i.stateGroup) && !['done', 'cancelled'].includes(i.stateName.toLowerCase());
export const isEpic = (i: PlaneItem): boolean => /^epic:/i.test(i.name);
export const short = (sha: string): string => sha.slice(0, 7);
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function itemLink(i: PlaneItem, nameChars = 60): string {
  return `[PET-${i.seq}](<${PLANE_BROWSE}/PET-${i.seq}/>) ${clip(i.name, nameChars)}`;
}
export const prLink = (repo: string, number: number, url: string): string => `[${repo.replace(/^petedio-/, '')}#${number}](<${url}>)`;

/** Open PRs across the repos that were read. */
export function openPrs(s: Snapshot): OpenPr[] {
  return s.repos.flatMap((r) => (r.ok ? r.open : []));
}

export interface ReadSummary {
  /** One line saying what was examined. */
  line: string;
  /** Everything that failed to read. Empty means the run saw all it set out to see. */
  gaps: string[];
}

/**
 * ⚠ THE FIRST THING A REPORT SAYS IS WHAT IT EXAMINED. "0 stale" after reading 40 PRs and
 * "0 stale" because the query returned nothing must not look alike (CLAUDE.md).
 */
export function summarizeReads(s: Snapshot): ReadSummary {
  const gaps: string[] = [];
  const okRepos = s.repos.filter((r): r is Extract<RepoRead, { ok: true }> => r.ok);
  for (const r of s.repos) if (!r.ok) gaps.push(`${r.repo} not read: ${r.error}`);
  const prGaps = okRepos.flatMap((r) => r.open.flatMap((p) => p.gaps.map((g) => `${prLink(p.repo, p.number, p.url)} ${g}`)));
  gaps.push(...prGaps);
  const open = okRepos.reduce((n, r) => n + r.open.length, 0);
  const closed = okRepos.reduce((n, r) => n + r.closedRead, 0);
  const gh = `${open} open and ${closed} recently closed PRs in ${okRepos.length} of ${s.repos.length} repos (${s.repos.map((r) => r.repo.replace(/^petedio-/, '')).join(', ')})`;
  let plane: string;
  if (s.plane.ok) {
    const open = s.plane.items.filter(isOpenItem).length;
    plane = `${s.plane.items.length} PET items (${open} open)`;
  } else {
    plane = 'Plane not read';
    gaps.push(`Plane not read: ${s.plane.error}`);
  }
  let cycles = '';
  if (s.cycles && !s.cycles.ok) gaps.push(`Cycles not read: ${s.cycles.error}`);
  else if (s.cycles) {
    const part = (label: string, c: { itemIds: string[] | null } | null): string => (c ? `${label} ${c.itemIds?.length ?? 0} items` : `no ${label} cycle`);
    cycles = `; ${s.cycles.dated} dated cycles${s.cycles.undated ? `, ${s.cycles.undated} undated skipped` : ''} (${part('current', s.cycles.current)}, ${part('previous', s.cycles.previous)})`;
  }
  return { line: `Read: ${gh}; ${plane}${cycles}.`, gaps };
}

export function gapBlock(gaps: string[]): string[] {
  if (gaps.length === 0) return [];
  const shown = gaps.slice(0, 8).map((g) => `- ${clip(g, 220)}`);
  if (gaps.length > 8) shown.push(`- and ${gaps.length - 8} more`);
  return ['', '**⚠ Not read, so these results are incomplete:**', ...shown];
}

export function ciStatus(c: CheckSummary | null): 'green' | 'red' | 'pending' | 'none' | 'skipped' | 'unread' {
  if (!c) return 'unread';
  if (c.failed.length) return 'red';
  if (c.pending.length) return 'pending';
  if (c.total === 0) return 'none';
  if (c.passed === 0) return 'skipped';
  return 'green';
}

export type CodexState =
  | { kind: 'unread' }
  | { kind: 'none' }
  | { kind: 'head'; verdict: CodexReview['verdict'] }
  | { kind: 'stale'; verdict: CodexReview['verdict']; sha: string };

export function codexState(codex: CodexReview[] | null, headSha: string): CodexState {
  if (!codex) return { kind: 'unread' };
  if (codex.length === 0) return { kind: 'none' };
  const sorted = [...codex].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const atHead = sorted.filter((r) => r.commitId === headSha);
  if (atHead.length) return { kind: 'head', verdict: atHead[atHead.length - 1]!.verdict };
  const last = sorted[sorted.length - 1]!;
  return { kind: 'stale', verdict: last.verdict, sha: last.commitId };
}

const VERDICT_WORDS: Record<CodexReview['verdict'], string> = {
  'changes-requested': 'changes requested',
  escalate: 'escalated to you',
  'no-blocking': 'no blocking findings',
};

export function codexText(c: CodexState): string {
  switch (c.kind) {
    case 'unread':
      return 'Codex unread';
    case 'none':
      return 'no Codex review';
    case 'head':
      return `Codex ${VERDICT_WORDS[c.verdict]}`;
    case 'stale':
      return `Codex ${VERDICT_WORDS[c.verdict]} on old head ${short(c.sha)}`;
  }
}

export function daysSince(iso: string, now: Date): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((now.getTime() - t) / 86_400_000) : -1;
}

export function capped(lines: string[], max: number): string[] {
  return lines.length <= max ? lines : [...lines.slice(0, max), `- and ${lines.length - max} more`];
}
