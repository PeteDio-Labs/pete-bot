/**
 * The Morning queue (PET-701): what waits on Pedro today. It replaces the Claude routine
 * of the same name, weekdays at 07:52 Eastern.
 *
 * It lists facts GitHub and Plane report. It does not read a comment and decide whether it
 * asks Pedro anything: it shows the newest comment on each `needs-pedro` item, trimmed, and
 * says so. The routine's model did that reading; a script does not.
 */
import type { PlaneComment } from './plane.js';
import {
  capped,
  ciStatus,
  clip,
  codexState,
  codexText,
  gapBlock,
  isOpenItem,
  itemLink,
  openPrs,
  prLink,
  short,
  summarizeReads,
  type Snapshot,
} from './snapshot.js';
import { localTime } from './schedule.js';
import type { OpenPr } from './collect.js';

/** The newest comment per item, by sequence number. `null` is no comment, `'error'` is a failed read. */
export type CommentMap = Map<number, PlaneComment | null | 'error'>;

export const COMMENT_ITEM_CAP = 20;

type Action = 'draft' | 'conflict' | 'ci-red' | 'fix-codex' | 'escalated' | 'ready' | 'waiting-codex' | 'waiting-ci' | 'unknown';

export function actionFor(p: OpenPr): { action: Action; text: string } {
  const ci = ciStatus(p.checks);
  const cx = codexState(p.codex, p.headSha);
  if (p.draft) return { action: 'draft', text: 'draft' };
  if (p.mergeable === false) return { action: 'conflict', text: 'merge conflict' };
  if (ci === 'red') return { action: 'ci-red', text: 'CI red' };
  if (cx.kind === 'head' && cx.verdict === 'changes-requested') return { action: 'fix-codex', text: 'fix the Codex findings' };
  if (cx.kind === 'head' && cx.verdict === 'escalate') return { action: 'escalated', text: 'Codex escalated: your call' };
  if (ci === 'pending') return { action: 'waiting-ci', text: 'CI running' };
  if (cx.kind === 'head' && cx.verdict === 'no-blocking' && (ci === 'green' || ci === 'none')) return { action: 'ready', text: 'ready: the desk merges tier 0-1, you tap tier 2' };
  if (cx.kind === 'none' || cx.kind === 'stale') return { action: 'waiting-codex', text: 'waiting on a Codex review of this head' };
  return { action: 'unknown', text: 'state unclear: a read failed' };
}

export function buildMorning(s: Snapshot, comments: CommentMap): string {
  const { line, gaps } = summarizeReads(s);
  const day = localTime(s.at).date;
  const prs = openPrs(s);
  const rows = prs.map((p) => ({ p, a: actionFor(p) }));
  const count = (a: Action): number => rows.filter((r) => r.a.action === a).length;

  const lines: string[] = [];
  lines.push(`${gaps.length ? '⚠ INCOMPLETE ' : ''}**Morning queue, ${day}**`);
  lines.push(line);
  lines.push(
    `PRs: ${prs.length} open · ${count('ready')} ready · ${count('escalated')} Codex escalated to you · ${count('conflict')} conflict · ${count('ci-red')} CI red · ${count('fix-codex')} Codex findings to fix.`,
  );
  lines.push('');
  lines.push('**Open PRs**');
  if (prs.length === 0) lines.push(s.repos.some((r) => r.ok) ? '- none open in the repos read' : '- no repo was read');
  const order: Action[] = ['escalated', 'ready', 'conflict', 'ci-red', 'fix-codex', 'waiting-ci', 'waiting-codex', 'unknown', 'draft'];
  const sorted = [...rows].sort((a, b) => order.indexOf(a.a.action) - order.indexOf(b.a.action));
  lines.push(
    ...capped(
      sorted.map(({ p, a }) => {
        const pet = p.petKeys.length ? ` PET-${p.petKeys.join(', PET-')}` : '';
        return `- ${prLink(p.repo, p.number, p.url)}${pet} \`${short(p.headSha)}\` · CI ${ciStatus(p.checks)} · ${codexText(codexState(p.codex, p.headSha))} · **${a.text}**`;
      }),
      30,
    ),
  );

  if (s.plane.ok) {
    const open = s.plane.items.filter(isOpenItem);
    const prKeys = new Set(prs.flatMap((p) => p.petKeys));
    const review = open.filter((i) => i.stateName.toLowerCase() === 'in review').sort((a, b) => a.seq - b.seq);
    lines.push('', `**Plane: In Review (${review.length})**`);
    if (review.length === 0) lines.push('- none');
    lines.push(...capped(review.map((i) => `- ${itemLink(i)}${prKeys.has(i.seq) ? '' : ' · no open PR in the repos read'}`), 20));

    const needs = open.filter((i) => i.labels.includes('needs-pedro')).sort((a, b) => a.seq - b.seq);
    lines.push('', `**Plane: labelled needs-pedro (${needs.length})**, newest comment shown, not interpreted`);
    if (needs.length === 0) lines.push('- none');
    for (const i of needs.slice(0, COMMENT_ITEM_CAP)) {
      const c = comments.get(i.seq);
      const tail = c === undefined ? 'comment not read' : c === 'error' ? 'comment read failed' : c === null ? 'no comments' : `${c.at.slice(0, 10)}: ${clip(c.text, 160)}`;
      lines.push(`- ${itemLink(i, 50)} · ${tail}`);
    }
    if (needs.length > COMMENT_ITEM_CAP) lines.push(`- and ${needs.length - COMMENT_ITEM_CAP} more, comments not read`);
  }

  lines.push(...gapBlock(gaps));
  lines.push('', '_Not read: comments on items without a `needs-pedro` label. A script cannot judge whether a comment asks you something._');
  return lines.join('\n');
}
