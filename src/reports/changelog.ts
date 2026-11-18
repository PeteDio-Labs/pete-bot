/**
 * The stack changelog in the weekly report (Pedro, 2026-11-18).
 *
 * The vault holds one table, `Systems/stack-changelog.md`, that a thread adds a row to whenever it
 * changes the stack. The weekly report copies the rows dated inside its week, so the report shows
 * what changed beside what merged.
 *
 * ⚠ A READ SAYS WHAT IT COVERS. "No change recorded" and "the changelog could not be read" are
 * different answers. A failed read stores `read: false` with the reason, never an empty list
 * (PET-298 and its siblings).
 */
import type { GithubReads } from './collect.js';

export const CHANGELOG_REPO = 'petedio-vault';
export const CHANGELOG_PATH = 'Systems/stack-changelog.md';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CELL_CAP = 400;

export interface ChangeRow {
  date: string;
  area: string;
  status: string;
  before: string;
  now: string;
  source: string;
}

export type ChangeRead = { read: true; rows: ChangeRow[]; tableRows: number } | { read: false; reason: string };

/** What the weekly record stores for a week. */
export type WeekChanges = { read: true; rows: ChangeRow[] } | { read: false; reason: string };

const clean = (cell: string): string =>
  cell
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => label ?? target)
    .replace(/`/g, '')
    .trim()
    .slice(0, CELL_CAP);

/** Reads the table. A row whose first cell is not a date, such as the header and the divider, is skipped. */
export function parseChangelog(markdown: string): { rows: ChangeRow[]; tableRows: number } {
  const rows: ChangeRow[] = [];
  let tableRows = 0;
  for (const line of markdown.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    tableRows++;
    const cells = t.replace(/^\||\|$/g, '').split('|').map(clean);
    if (cells.length < 6 || !DATE_RE.test(cells[0]!)) continue;
    rows.push({ date: cells[0]!, area: cells[1]!, status: cells[2]!, before: cells[3]!, now: cells[4]!, source: cells.slice(5).join(' | ') });
  }
  return { rows, tableRows };
}

/** Reads the changelog from GitHub. Never throws: a failure comes back as `read: false`. */
export async function readChangelog(gh: GithubReads, org: string): Promise<ChangeRead> {
  try {
    const f = await gh.get<{ content?: string; encoding?: string }>('reading the stack changelog', `/repos/${org}/${CHANGELOG_REPO}/contents/${CHANGELOG_PATH}`);
    if (f.encoding !== 'base64' || typeof f.content !== 'string') return { read: false, reason: 'the file answered in an unexpected form' };
    const { rows, tableRows } = parseChangelog(Buffer.from(f.content, 'base64').toString('utf8'));
    // A file with no table at all is a broken read, not an empty week.
    if (tableRows === 0) return { read: false, reason: 'the file holds no table' };
    return { read: true, rows, tableRows };
  } catch (err) {
    return { read: false, reason: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}

const DAY_MS = 86_400_000;

/** The rows dated from the Monday `week` through its Sunday, newest first. */
export function rowsForWeek(rows: ChangeRow[], week: string): ChangeRow[] {
  const start = Date.parse(`${week}T00:00:00Z`);
  const end = start + 7 * DAY_MS;
  return rows
    .filter((r) => {
      const t = Date.parse(`${r.date}T00:00:00Z`);
      return t >= start && t < end;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}
