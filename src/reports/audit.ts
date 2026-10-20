/**
 * The Hanging audit (PET-701): Plane against GitHub. It replaces the Claude routine of the
 * same name, Mondays at 08:44 Eastern.
 *
 * It reports state drift a script can prove from PR titles and branch names (`PET-<n>`,
 * `pet-<n>-<slug>`). It proposes nothing and changes nothing.
 *
 * NOT RUN, AND SAID SO: the live-infrastructure probes. A script on 237 does not stand in
 * for `lab-verify.sh`, so the report names the probes as unchecked.
 */
import type { ClosedPr, OpenPr } from './collect.js';
import type { PlaneItem } from './plane.js';
import { localTime } from './schedule.js';
import type { VaultRead } from './vault.js';
import { capped, clip, gapBlock, isEpic, isOpenItem, itemLink, openPrs, prLink, summarizeReads, type Snapshot } from './snapshot.js';

const PART_BRANCH = /^pet-\d+-part-/i;

export interface PrIndex {
  open: Map<number, OpenPr[]>;
  /** Merged PRs that deliver the whole item. A `-part-` branch leaves the item open (PET-490). */
  merged: Map<number, ClosedPr[]>;
  closedUnmerged: Map<number, ClosedPr[]>;
}

export function indexPrs(s: Snapshot): PrIndex {
  const idx: PrIndex = { open: new Map(), merged: new Map(), closedUnmerged: new Map() };
  const push = <T>(m: Map<number, T[]>, k: number, v: T): void => {
    m.set(k, [...(m.get(k) ?? []), v]);
  };
  for (const r of s.repos) {
    if (!r.ok) continue;
    for (const p of r.open) for (const k of p.petKeys) push(idx.open, k, p);
    for (const p of r.closed) {
      for (const k of p.petKeys) {
        if (p.mergedAt) {
          if (!PART_BRANCH.test(p.headRef)) push(idx.merged, k, p);
        } else push(idx.closedUnmerged, k, p);
      }
    }
  }
  return idx;
}

const lower = (i: PlaneItem): string => i.stateName.toLowerCase();

export function buildAudit(s: Snapshot, vault: VaultRead | null): string {
  const { line, gaps } = summarizeReads(s);
  const day = localTime(s.at).date;
  const lines: string[] = [];
  const sections: string[][] = [];

  if (!s.plane.ok) {
    return [`⚠ INCOMPLETE **Hanging audit, ${day}**`, line, '', 'Plane was not read, so no item could be compared with a PR. Nothing below this line was checked.', ...gapBlock(gaps)].join('\n');
  }
  const idx = indexPrs(s);
  const open = s.plane.items.filter((i) => isOpenItem(i) && !isEpic(i)).sort((a, b) => a.seq - b.seq);
  const today = day;

  const a = open.filter((i) => ['backlog', 'todo'].includes(lower(i)) && idx.open.has(i.seq));
  const b = open.filter((i) => !idx.open.has(i.seq) && idx.merged.has(i.seq));
  const bSet = new Set(b.map((i) => i.seq));
  const c = open.filter((i) => lower(i) === 'in review' && !idx.open.has(i.seq) && !bSet.has(i.seq));
  const d = open.filter(
    (i) => ['todo', 'in progress', 'in review'].includes(lower(i)) && !idx.open.has(i.seq) && !idx.merged.has(i.seq) && idx.closedUnmerged.has(i.seq),
  );
  const e = open.filter((i) => i.targetDate && i.targetDate < today);
  const f = openPrs(s).filter((p) => p.petKeys.length === 0);

  const section = (title: string, rows: string[], none: string): void => {
    sections.push([`**${title} (${rows.length})**`, ...(rows.length ? capped(rows, 15) : [`- ${none}`])]);
  };
  section(
    'Open PR, item still in Backlog or Todo: move to In Review',
    a.map((i) => `- ${itemLink(i)} · ${idx.open.get(i.seq)!.map((p) => prLink(p.repo, p.number, p.url)).join(', ')}`),
    'none',
  );
  section(
    'Every PR merged, item not Done: move to Done or In Progress',
    b.map((i) => `- ${itemLink(i)} (${i.stateName}) · merged ${idx.merged.get(i.seq)!.map((p) => prLink(p.repo, p.number, p.url)).join(', ')}`),
    'none',
  );
  section(
    'In Review with no open PR and no merged PR in the window',
    c.map((i) => `- ${itemLink(i)}${i.labels.includes('needs-pedro') ? ' · needs-pedro' : ''}`),
    'none',
  );
  section(
    'Only a closed, unmerged PR names the item',
    d.map((i) => `- ${itemLink(i)} (${i.stateName}) · ${idx.closedUnmerged.get(i.seq)!.map((p) => prLink(p.repo, p.number, p.url)).join(', ')}`),
    'none',
  );
  section('Target date has passed', e.map((i) => `- ${itemLink(i)} (${i.stateName}) · due ${i.targetDate}`), 'none');
  section('Open PR names no PET item', f.map((p) => `- ${prLink(p.repo, p.number, p.url)} ${clip(p.title, 70)}`), 'none');

  const flagged = new Set([...a, ...b, ...c, ...d, ...e].map((i) => i.seq));
  lines.push(`${gaps.length ? '⚠ INCOMPLETE ' : ''}**Hanging audit, ${day}**`);
  lines.push(line);
  lines.push(`${flagged.size} of ${open.length} open non-epic items drift; ${f.length} open PRs name no item. Nothing was changed.`);
  for (const sec of sections) lines.push('', ...sec);

  lines.push('', '**Doc freshness**');
  if (!vault) lines.push('- not read: `REPORT_VAULT_PATH` is unset on this host');
  else if (!vault.ok) lines.push(`- not read: ${vault.error}`);
  else {
    lines.push(`- read ${vault.notes} notes, ${vault.dated} carry \`verified:\`; ${vault.stale.length} older than ${vault.thresholdDays} days.`);
    lines.push(...vault.stale.slice(0, 5).map((n) => `- ${n.note} · ${n.verified}`));
  }

  lines.push(...gapBlock(gaps));
  const closedRead = s.repos.reduce((n, r) => n + (r.ok ? r.closedRead : 0), 0);
  lines.push('', `_Not checked: live-infrastructure probes (\`lab-verify.sh\` needs a LAN session), merges older than the ${closedRead} closed PRs read, and comments on items._`);
  return lines.join('\n');
}
