/**
 * The Plane board as a hub record (PET-871): items done per week, items stuck In Review, the
 * label mix of open work, and the MED board when its project id is set. One record per local
 * day; a second run the same day replaces the first.
 *
 * ⚠ A record says what it read. A board that could not be read stores `unread` with the reason,
 * never zero counts, so "0 stuck" after reading 400 items and "0 stuck" after reading none
 * cannot look alike.
 *
 * "Done in a week" counts completed items by their last-updated day, because Plane's list route
 * gives no completion time. An item edited after it closed moves to the later week.
 */
import { clip, isOpenItem } from './snapshot.js';
import type { PlaneItem, PlaneRead } from './plane.js';
import type { HubRecord } from './hub.js';

export const PLANE_KIND = 'plane';
export const WEEKS = 8;
export const STUCK_DAYS = 3;
const LIST_CAP = 15;
const LABEL_CAP = 12;

const DAY_MS = 86_400_000;

/** Monday (UTC) of the week holding `iso`, as YYYY-MM-DD, or null when `iso` is not a date. */
export function weekStart(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
}

export interface BoardTally {
  items: number;
  open: number;
  doneByWeek: { week: string; done: number }[];
  inReview: number;
  stuck: { key: string; name: string; state: string; days: number }[];
  stuckTotal: number;
  /** Items in review whose last-update time is missing, so their wait cannot be judged. */
  undatedReview: number;
  labelMix: { label: string; open: number }[];
}

export function tallyBoard(items: PlaneItem[], prefix: string, at: Date): BoardTally {
  const open = items.filter(isOpenItem);
  const thisWeek = weekStart(at.toISOString())!;
  const weeks: string[] = [];
  for (let i = WEEKS - 1; i >= 0; i--) weeks.push(new Date(Date.parse(thisWeek) - i * 7 * DAY_MS).toISOString().slice(0, 10));
  const done = new Map(weeks.map((w) => [w, 0]));
  for (const i of items) {
    if (isOpenItem(i) || i.stateGroup === 'cancelled') continue;
    const w = weekStart(i.updatedAt);
    if (w && done.has(w)) done.set(w, done.get(w)! + 1);
  }
  const review = open.filter((i) => /review/i.test(i.stateName));
  const stuck = review
    .map((i) => ({ i, days: Math.floor((at.getTime() - Date.parse(i.updatedAt)) / DAY_MS) }))
    .filter((x) => Number.isFinite(x.days) && x.days >= STUCK_DAYS)
    .sort((a, b) => b.days - a.days);
  const undatedReview = review.filter((i) => !Number.isFinite(Date.parse(i.updatedAt))).length;
  const mix = new Map<string, number>();
  for (const i of open) for (const l of i.labels.length ? i.labels : ['(no label)']) mix.set(l, (mix.get(l) ?? 0) + 1);
  return {
    items: items.length,
    open: open.length,
    doneByWeek: weeks.map((week) => ({ week, done: done.get(week)! })),
    inReview: review.length,
    stuckTotal: stuck.length,
    undatedReview,
    stuck: stuck.slice(0, LIST_CAP).map(({ i, days }) => ({ key: `${prefix}-${i.seq}`, name: clip(i.name, 80), state: i.stateName, days })),
    labelMix: [...mix].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, LABEL_CAP).map(([label, n]) => ({ label, open: n })),
  };
}

export interface BoardRead {
  prefix: string;
  read: PlaneRead;
}

/** `med` is null when no MED project id is set, which the record states. */
export function planeRecord(pet: PlaneRead, med: PlaneRead | null, date: string, at: Date): HubRecord {
  const board = (prefix: string, r: PlaneRead): Record<string, unknown> => (r.ok ? { ok: true, ...tallyBoard(r.items, prefix, at) } : { ok: false, unread: r.error.slice(0, 200) });
  return {
    id: date,
    generatedAt: at.toISOString(),
    stuckAfterDays: STUCK_DAYS,
    pet: board('PET', pet),
    med: med ? board('MED', med) : { ok: false, unread: 'no MED project id is set on this host (PLANE_MED_PROJECT_ID)' },
  };
}
