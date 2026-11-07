import { describe, expect, it } from 'bun:test';
import { cycleRecord } from './hubCycle.js';
import type { PlaneItem } from './plane.js';
import type { Snapshot } from './snapshot.js';

const item = (seq: number, over: Partial<PlaneItem> = {}): PlaneItem => ({ id: `i${seq}`, seq, name: `Item ${seq}`, stateName: 'Todo', stateGroup: 'unstarted', labels: [], parent: null, targetDate: null, updatedAt: '', priority: 'none', ...over });
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  at: new Date('2026-11-07T12:00:00Z'),
  repos: [],
  plane: { ok: true, items: [item(1, { stateName: 'Done', stateGroup: 'completed', labels: ['cloud'] }), item(2, { stateGroup: 'started', stateName: 'In Progress', labels: ['cloud'] }), item(3, { labels: ['needs-pedro'] }), item(4)] } as never,
  cycles: { ok: true, current: { id: 'c', name: 'Week of 2026-11-02', start: '2026-11-02', end: '2026-11-08', itemIds: ['i1', 'i2', 'i3', 'i4', 'gone'] }, previous: null, next: null, upcoming: [], dated: 3, undated: 1 },
  ...over,
});

describe('cycleRecord', () => {
  it('tallies the cycle by state and route, and counts items the board read lacks', () => {
    const r = cycleRecord(snap(), '2026-11-07')!;
    expect(r).toMatchObject({ id: '2026-11-07', total: 4, done: 1, open: 3, inProgress: 1, needsPedro: 1, lost: 1 });
    expect(r.byRoute).toEqual({ pedro: { total: 1, done: 0 }, ai: { total: 2, done: 1 }, other: { total: 1, done: 0 } });
    expect((r.openItems as { seq: number }[]).map((i) => i.seq)).toEqual([2, 3, 4]);
    expect(r.examined).toEqual({ planeItems: 4, datedCycles: 3, undatedCycles: 1 });
  });
  it('stores a day with no cycle as null with the reason', () => {
    const r = cycleRecord(snap({ cycles: { ok: true, current: null, previous: null, next: null, upcoming: [], dated: 0, undated: 0 } }), '2026-11-07')!;
    expect(r.cycle).toBeNull();
    expect(r.reason).toContain('no cycle covers');
  });
  it('stores nothing when Plane or the cycles were not read', () => {
    expect(cycleRecord(snap({ cycles: { ok: false, error: 'x' } }), '2026-11-07')).toBeNull();
    expect(cycleRecord(snap({ cycles: undefined }), '2026-11-07')).toBeNull();
    expect(cycleRecord(snap({ plane: { ok: false, error: 'x' } as never }), '2026-11-07')).toBeNull();
  });
});
