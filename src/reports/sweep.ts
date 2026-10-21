/**
 * The Stale PR, Plane and thread sweep (PET-701), daily at 18:47 Eastern, or Mondays only
 * once REPORT_SWEEP_WEEKLY is true. It replaces the Claude routine of the same name.
 *
 * It comments on nothing. The routine commented on each PR it flagged; a script posts one
 * DM and leaves the PRs alone.
 *
 * THREADS ARE NOT READ. The project's threads have no API a script can call, so the report
 * says so on every run instead of omitting the section.
 */
import type { ClosedPr } from './collect.js';
import { indexPrs } from './audit.js';
import { localTime } from './schedule.js';
import {
  capped,
  ciStatus,
  clip,
  codexState,
  daysSince,
  gapBlock,
  isEpic,
  isOpenItem,
  itemLink,
  openPrs,
  prLink,
  short,
  summarizeReads,
  type Snapshot,
} from './snapshot.js';

const ROUTING_LABELS = ['cloud', 'lan', 'mac', 'needs-pedro'];
const IN_PROGRESS_DAYS = 7;

/** A PR merged while Codex's last word on its head was "changes requested", or arrived after the merge. */
export function mergedOverCodex(p: ClosedPr): string | null {
  if (!p.mergedAt || !p.codex || p.codex.length === 0) return null;
  const sorted = [...p.codex].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const atHead = sorted.filter((r) => r.commitId === p.headSha);
  const last = atHead[atHead.length - 1];
  if (last && last.verdict === 'changes-requested' && last.submittedAt <= p.mergedAt) return `Codex asked for changes at \`${short(p.headSha)}\` and the PR merged anyway`;
  const late = sorted.find((r) => r.verdict === 'changes-requested' && r.submittedAt > p.mergedAt!);
  if (late) return `Codex asked for changes at \`${short(late.commitId)}\` after the merge`;
  return null;
}

export function buildSweep(s: Snapshot, staleDays: number): string {
  const { line, gaps } = summarizeReads(s);
  const day = localTime(s.at).date;
  const prs = openPrs(s);
  const sections: string[][] = [];
  const section = (title: string, rows: string[]): void => {
    sections.push([`**${title} (${rows.length})**`, ...(rows.length ? capped(rows, 12) : ['- none'])]);
  };

  const merged = s.repos.flatMap((r) => (r.ok ? r.closed.filter((p) => p.mergedAt && p.codex !== null) : []));
  const prLine = (p: { repo: string; number: number; url: string; title: string }, tail: string): string => `- ${prLink(p.repo, p.number, p.url)} ${clip(p.title, 50)} · ${tail}`;

  section('Open PRs with a merge conflict', prs.filter((p) => p.mergeable === false).map((p) => prLine(p, `\`${short(p.headSha)}\``)));
  section('Open PRs with red CI', prs.filter((p) => ciStatus(p.checks) === 'red').map((p) => prLine(p, `\`${short(p.headSha)}\` · ${p.checks!.failed.slice(0, 3).join(', ')}`)));
  section(
    `Open PRs idle ${staleDays} days or more`,
    prs
      .map((p) => ({ p, d: daysSince(p.updatedAt, s.at) }))
      .filter(({ d }) => d >= staleDays)
      .sort((a, b) => b.d - a.d)
      .map(({ p, d }) => prLine(p, `${d} days${p.draft ? ', draft' : ''}`)),
  );
  section(
    'Open PRs where Codex requested changes on the current head',
    prs.filter((p) => { const c = codexState(p.codex, p.headSha); return c.kind === 'head' && c.verdict === 'changes-requested'; }).map((p) => prLine(p, `\`${short(p.headSha)}\``)),
  );
  const over = merged.map((p) => ({ p, why: mergedOverCodex(p) })).filter((x): x is { p: ClosedPr; why: string } => x.why !== null);
  section('Merged in the last 14 days over a Codex "Changes requested"', over.map(({ p, why }) => prLine(p, why)));

  if (s.plane.ok) {
    const idx = indexPrs(s);
    const open = s.plane.items.filter((i) => isOpenItem(i) && !isEpic(i)).sort((a, b) => a.seq - b.seq);
    const inReview = open.filter((i) => i.stateName.toLowerCase() === 'in review' && !idx.open.has(i.seq));
    section('Plane: In Review with no open PR', inReview.map((i) => `- ${itemLink(i, 50)}`));
    section('Plane: open items with none of cloud, lan, mac or needs-pedro', open.filter((i) => !i.labels.some((l) => ROUTING_LABELS.includes(l))).map((i) => `- ${itemLink(i, 50)}`));
    section('Plane: open items with no parent epic', open.filter((i) => !i.parent).map((i) => `- ${itemLink(i, 50)}`));
    section(
      `Plane: In Progress with no update for ${IN_PROGRESS_DAYS} days or more (a bulk edit resets this date)`,
      open.filter((i) => i.stateName.toLowerCase() === 'in progress' && daysSince(i.updatedAt, s.at) >= IN_PROGRESS_DAYS).map((i) => `- ${itemLink(i, 50)} · ${daysSince(i.updatedAt, s.at)} days`),
    );
  }

  const flagged = sections.reduce((n, sec) => n + Math.max(0, sec.length - 1 - (sec[1] === '- none' ? 1 : 0)), 0);
  const lines = [`${gaps.length ? '⚠ INCOMPLETE ' : ''}**Stale PR, Plane and thread sweep, ${day}**`, line];
  lines.push(`${flagged} flagged lines${gaps.length ? ', from an incomplete read' : ''}. Nothing was commented on or changed.`);
  for (const sec of sections) lines.push('', ...sec);
  lines.push(...gapBlock(gaps));
  lines.push('', '_Threads: not read. A script cannot list the project\'s threads, so a stalled thread needs your eye or a hand-run sweep._');
  return lines.join('\n');
}
