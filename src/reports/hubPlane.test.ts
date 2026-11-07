import { describe, expect, it } from 'bun:test';
import { planeRecord, tallyBoard, weekStart } from './hubPlane.js';
import { HubJobs } from './hubJobs.js';
import { ReportHub } from './hub.js';
import type { PlaneItem } from './plane.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AT = new Date('2026-11-07T15:00:00Z');
const item = (seq: number, over: Partial<PlaneItem> = {}): PlaneItem => ({ id: `i${seq}`, seq, name: `Item ${seq}`, stateName: 'Todo', stateGroup: 'unstarted', labels: [], parent: null, targetDate: null, updatedAt: '2026-11-06T00:00:00Z', priority: 'none', ...over });

describe('weekStart', () => {
  it('returns the Monday of the week', () => {
    expect(weekStart('2026-11-07T15:00:00Z')).toBe('2026-11-02');
    expect(weekStart('2026-11-08T23:59:00Z')).toBe('2026-11-02');
    expect(weekStart('nope')).toBeNull();
  });
});

describe('tallyBoard', () => {
  const items = [
    item(1, { stateName: 'Done', stateGroup: 'completed', updatedAt: '2026-11-05T00:00:00Z' }),
    item(2, { stateName: 'Done', stateGroup: 'completed', updatedAt: '2026-10-28T00:00:00Z' }),
    item(3, { stateName: 'Cancelled', stateGroup: 'cancelled', updatedAt: '2026-11-05T00:00:00Z' }),
    item(4, { stateName: 'In Review', stateGroup: 'started', updatedAt: '2026-11-01T00:00:00Z', labels: ['cloud'] }),
    item(5, { stateName: 'In Review', stateGroup: 'started', updatedAt: '2026-11-07T00:00:00Z', labels: ['cloud', 'security'] }),
    item(6),
    item(7, { stateName: 'In Review', stateGroup: 'started', updatedAt: '' }),
  ];
  const t = tallyBoard(items, 'PET', AT);
  it('counts done per week and leaves cancelled items out', () => {
    expect(t.doneByWeek).toHaveLength(8);
    expect(t.doneByWeek.at(-1)).toEqual({ week: '2026-11-02', done: 1 });
    expect(t.doneByWeek.at(-2)).toEqual({ week: '2026-10-26', done: 1 });
  });
  it('lists only reviews older than the stuck limit', () => {
    expect(t).toMatchObject({ items: 7, open: 4, inReview: 3, stuckTotal: 1, undatedReview: 1 });
    expect(t.stuck).toEqual([{ key: 'PET-4', name: 'Item 4', state: 'In Review', days: 6 }]);
  });
  it('mixes labels and names unlabelled items', () => {
    expect(t.labelMix[0]).toEqual({ label: 'cloud', open: 2 });
    expect(t.labelMix.find((l) => l.label === '(no label)')?.open).toBe(1);
  });
});

describe('planeRecord', () => {
  it('stores an unread MED board with the reason', () => {
    const r = planeRecord({ ok: true, items: [item(1)], states: 1, labels: 0 }, null, '2026-11-07', AT);
    expect((r.med as { unread: string }).unread).toContain('PLANE_MED_PROJECT_ID');
    expect((r.pet as { ok: boolean }).ok).toBe(true);
  });
});

describe('HubJobs', () => {
  const log = { info() {}, warn() {} };
  it('stores once per day, retries a failure, and skips before its hour', async () => {
    const hub = new ReportHub(mkdtempSync(join(tmpdir(), 'hubjobs-')));
    let calls = 0;
    let fail = true;
    let now = new Date('2026-11-07T08:00:00Z'); // 03:00 Eastern
    const jobs = new HubJobs(hub, [{ kind: 'plane', hour: 6, collect: async (at) => { calls++; if (fail) throw new Error('down'); return { id: '2026-11-07', generatedAt: at.toISOString() }; } }], log, () => now);
    await jobs.tick();
    expect(calls).toBe(0);
    now = new Date('2026-11-07T12:00:00Z');
    await jobs.tick();
    expect(jobs.last.get('plane')).toMatchObject({ ok: false, detail: 'down' });
    fail = false;
    await jobs.tick();
    await jobs.tick();
    expect(calls).toBe(2);
    expect(hub.has('plane', '2026-11-07')).toBe(true);
  });
});
