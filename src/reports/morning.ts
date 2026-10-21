/**
 * The Morning queue (PET-701): what waits on Pedro today. It replaces the Claude routine
 * of the same name, Mondays and Fridays at 07:52 Eastern (workspace#169).
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
import type { PlaneCycle, PlaneItem } from './plane.js';

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

const PEDRO_LABELS = ['lan', 'mac', 'needs-pedro'];
/** workspace#169: at most eight items per kind in a cycle. */
export const CYCLE_LIMIT = 8;

/** The Monday after `date` (YYYY-MM-DD), in the date's own calendar. */
export function nextMonday(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

/**
 * The cycle view (workspace#169): this week's cycle split by who does the work. Pedro's items
 * carry lan, mac or needs-pedro. The AI items carry cloud. Plane's own list is the source: a
 * cycle item the board read cannot find is counted and named, never dropped.
 */
export function cycleBlock(s: Snapshot): string[] {
  if (!s.cycles || !s.cycles.ok || !s.plane.ok) return [];
  const { current } = s.cycles;
  if (!current) return ['', `**Cycle**`, `- no cycle covers ${localTime(s.at).date}. Create \`Week of <Monday>\` in Plane.`];
  const byId = new Map(s.plane.items.map((i) => [i.id, i]));
  const ids = current.itemIds ?? [];
  const items = ids.map((id) => byId.get(id)).filter((i): i is PlaneItem => !!i).sort((a, b) => a.seq - b.seq);
  const lost = ids.length - items.length;
  const pedro = items.filter((i) => i.labels.some((l) => PEDRO_LABELS.includes(l)));
  const ai = items.filter((i) => !pedro.includes(i) && i.labels.includes('cloud'));
  const other = items.filter((i) => !pedro.includes(i) && !ai.includes(i));

  const out: string[] = ['', `**Cycle: ${clip(current.name, 40)}** (${current.start} to ${current.end}), ${ids.length} items`];
  const group = (title: string, rows: PlaneItem[], limitNote: boolean): void => {
    const open = rows.filter(isOpenItem);
    const over = limitNote && rows.length > CYCLE_LIMIT ? ` · over the limit of ${CYCLE_LIMIT}` : '';
    out.push(`${title}: ${rows.length} · ${rows.length - open.length} done · ${open.length} open${over}`);
    out.push(...capped(open.map((i) => `- ${itemLink(i, 50)} · ${[i.stateName, ...i.labels.filter((l) => [...PEDRO_LABELS, 'cloud'].includes(l))].join(' · ')}`), 12));
  };
  group('Pedro (lan, mac, needs-pedro)', pedro, true);
  group('AI (cloud)', ai, true);
  if (other.length) group('No routing label', other, false);
  if (lost > 0) out.push(`- ${lost} cycle items are not on the board read (archived or deleted), so they are not shown`);
  return out;
}

/**
 * Monday only: what last week's cycle left open and whether next week's cycle exists. The
 * report reads Plane and writes nothing, so it lists the move and does not make it.
 */
export function rolloverBlock(s: Snapshot): string[] {
  const t = localTime(s.at);
  if (t.weekday !== 1 || !s.cycles || !s.cycles.ok || !s.plane.ok) return [];
  const { previous, next, current } = s.cycles;
  const out: string[] = ['', '**Cycle rollover (Monday)**'];
  const left = (c: PlaneCycle): PlaneItem[] => {
    const byId = new Map((s.plane as Extract<typeof s.plane, { ok: true }>).items.map((i) => [i.id, i]));
    return (c.itemIds ?? []).map((id) => byId.get(id)).filter((i): i is PlaneItem => !!i && isOpenItem(i)).sort((a, b) => a.seq - b.seq);
  };
  if (!previous) out.push('- no earlier cycle found, so there is nothing to roll over');
  else {
    const open = left(previous);
    const missing = (previous.itemIds?.length ?? 0) - (previous.itemIds ?? []).filter((id) => (s.plane as Extract<typeof s.plane, { ok: true }>).items.some((i) => i.id === id)).length;
    out.push(`- ${clip(previous.name, 40)} (${previous.start} to ${previous.end}): ${previous.itemIds?.length ?? 0} items, ${open.length} still open${current ? `. Move them to ${clip(current.name, 40)} or drop them.` : '.'}`);
    out.push(...capped(open.map((i) => `  - ${itemLink(i, 50)} · ${i.stateName}`), 15));
    if (missing > 0) out.push(`  - ${missing} items of that cycle are not on the board read, so they are not listed`);
  }
  const want = nextMonday(t.date);
  if (next && next.start === want) out.push(`- Next week's cycle exists: ${clip(next.name, 40)}.`);
  else if (next) out.push(`- Could not match next week's cycle: Plane has ${clip(next.name, 40)} starting ${next.start}, and the report expected a cycle starting ${want}. Check it by hand.`);
  else out.push(`- Next week's cycle does not exist. Create \`Week of ${want}\`.`);
  out.push('_This report moves and creates nothing. The transfer is a hand step until a write path exists._');
  return out;
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

  lines.push(...cycleBlock(s));
  lines.push(...rolloverBlock(s));

  lines.push(...gapBlock(gaps));
  lines.push('', '_Not read: comments on items without a `needs-pedro` label. A script cannot judge whether a comment asks you something._');
  return lines.join('\n');
}
