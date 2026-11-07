/**
 * The Plane cycle as a hub record (PET-868), taken from the morning queue's snapshot, so the
 * dashboard shows the cycle as the morning DM saw it. One record per local day.
 *
 * ⚠ A record says what it read. A cycle item the board read cannot find is counted in `lost`,
 * never dropped, and a day with no covering cycle is stored as `cycle: null` with the reason.
 */
import { clip, isOpenItem, type Snapshot } from './snapshot.js';
import { PEDRO_LABELS } from './morning.js';
import type { PlaneItem } from './plane.js';
import type { HubRecord } from './hub.js';

export const CYCLE_KIND = 'cycle';
const LIST_CAP = 15;

interface Tally {
  total: number;
  done: number;
}
const tally = (rows: PlaneItem[]): Tally => ({ total: rows.length, done: rows.filter((i) => !isOpenItem(i)).length });

/** Null when the morning snapshot did not read both Plane and the cycles, so nothing is stored. */
export function cycleRecord(s: Snapshot, date: string): HubRecord | null {
  if (!s.cycles || !s.cycles.ok || !s.plane.ok) return null;
  const base = { id: date, generatedAt: s.at.toISOString(), examined: { planeItems: s.plane.items.length, datedCycles: s.cycles.dated, undatedCycles: s.cycles.undated } };
  const { current } = s.cycles;
  if (!current) return { ...base, cycle: null, reason: `no cycle covers ${date}` };
  const byId = new Map(s.plane.items.map((i) => [i.id, i]));
  const ids = current.itemIds ?? [];
  const items = ids.map((id) => byId.get(id)).filter((i): i is PlaneItem => !!i).sort((a, b) => a.seq - b.seq);
  const pedro = items.filter((i) => i.labels.some((l) => PEDRO_LABELS.includes(l)));
  const ai = items.filter((i) => !pedro.includes(i) && i.labels.includes('cloud'));
  const other = items.filter((i) => !pedro.includes(i) && !ai.includes(i));
  const open = items.filter(isOpenItem);
  return {
    ...base,
    cycle: { name: clip(current.name, 60), start: current.start, end: current.end },
    ...tally(items),
    open: open.length,
    inProgress: open.filter((i) => i.stateGroup === 'started').length,
    needsPedro: open.filter((i) => i.labels.includes('needs-pedro')).length,
    lost: ids.length - items.length,
    byRoute: { pedro: tally(pedro), ai: tally(ai), other: tally(other) },
    openItems: open.slice(0, LIST_CAP).map((i) => ({ seq: i.seq, name: clip(i.name, 80), state: i.stateName, labels: i.labels.filter((l) => [...PEDRO_LABELS, 'cloud'].includes(l)) })),
  };
}
