/** PET-492 — the backup schedule as an answer to "is this maintenance?". */
import { describe, it, expect } from 'bun:test';
import { parseWindows, scheduleDecider } from './decider.js';

const decider = scheduleDecider(parseWindows('America/New_York 02:45 30'));

describe('parseWindows', () => {
  it('reads an empty value as no windows', () => {
    expect(parseWindows('')).toEqual([]);
  });

  it('reads several windows', () => {
    expect(parseWindows('America/New_York 02:45 30, UTC 12:00 5')).toHaveLength(2);
  });

  it.each(['nonsense', 'America/New_York 2:45 30', 'America/New_York 25:00 30', 'Not/AZone 02:45 30', 'UTC 02:45 0'])(
    'throws on "%s" so the deploy check fails instead of the hold turning off',
    (bad) => {
      expect(() => parseWindows(bad)).toThrow(/ALERT_MAINTENANCE_WINDOWS/);
    },
  );
});

describe('scheduleDecider', () => {
  // 06:47 UTC is 02:47 EDT in September.
  it('holds inside the window, read in the window zone', () => {
    expect(decider.isMaintenance(new Date('2026-09-23T06:47:00Z'))).toContain('America/New_York');
  });

  it('opens at the start minute and closes after the length', () => {
    expect(decider.isMaintenance(new Date('2026-09-23T06:45:00Z'))).not.toBeNull();
    expect(decider.isMaintenance(new Date('2026-09-23T06:44:59Z'))).toBeNull();
    expect(decider.isMaintenance(new Date('2026-09-23T07:14:59Z'))).not.toBeNull();
    expect(decider.isMaintenance(new Date('2026-09-23T07:15:00Z'))).toBeNull();
  });

  it('does not hold at 14:00 UTC', () => {
    expect(decider.isMaintenance(new Date('2026-09-23T14:00:00Z'))).toBeNull();
  });

  it('follows daylight saving: 02:47 local is 07:47 UTC in winter', () => {
    expect(decider.isMaintenance(new Date('2026-12-15T07:47:00Z'))).not.toBeNull();
    expect(decider.isMaintenance(new Date('2026-12-15T06:47:00Z'))).toBeNull();
  });

  it('wraps a window across midnight', () => {
    const wrap = scheduleDecider(parseWindows('UTC 23:50 20'));
    expect(wrap.isMaintenance(new Date('2026-09-23T00:05:00Z'))).not.toBeNull();
    expect(wrap.isMaintenance(new Date('2026-09-23T00:15:00Z'))).toBeNull();
  });

  it('holds nothing with no windows', () => {
    expect(scheduleDecider([]).isMaintenance(new Date('2026-09-23T06:47:00Z'))).toBeNull();
  });
});
