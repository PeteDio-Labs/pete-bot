import { describe, expect, test } from 'bun:test';
import { StagingClock, LIMIT_S, alertText } from './stagingClock.js';

const t = new Date('2026-11-19T12:00:00Z');
const up = (h: number) => ({ status: 'running', uptimeSec: h * 3600 });

describe('StagingClock', () => {
  test('alerts once per threshold, and not on the first reading after a restart', () => {
    const c = new StagingClock();
    expect(c.observe(up(4), t).alerts).toEqual([]); // primed: the 3h alert is marked sent, not sent
    expect(c.observe(up(5), t).alerts).toEqual([]);
    expect(c.observe(up(9.1), t).alerts).toEqual([9]);
    expect(c.observe(up(9.2), t).alerts).toEqual([]);
    expect(c.observe(up(20.5), t).alerts).toEqual([20]);
  });
  test('a crossing seen after the first reading alerts', () => {
    const c = new StagingClock();
    c.observe(up(1), t);
    expect(c.observe(up(3.01), t).alerts).toEqual([3]);
  });
  test('a shorter uptime is a new boot, and its alerts start over', () => {
    const c = new StagingClock();
    c.observe(up(1), t);
    c.observe(up(3.5), t);
    c.observe(up(0.1), t);
    expect(c.observe(up(3.2), t).alerts).toEqual([3]);
  });
  test('reports time left', () => {
    const r = new StagingClock().observe(up(20), t).state;
    expect(r.state === 'up' && r.shutsDownInSec).toBe(4 * 3600);
  });
  test('stopped after a reading near 24 hours is the limit; any other stop is not', () => {
    const c = new StagingClock();
    c.observe({ status: 'running', uptimeSec: LIMIT_S - 60 }, t);
    expect(c.observe({ status: 'stopped', uptimeSec: 0 }, t).state.state).toBe('limit');
    c.observe(up(5), t);
    expect(c.observe({ status: 'stopped', uptimeSec: 0 }, t).state.state).toBe('stopped');
  });
  test('a stop never seen up is stopped, not limit, and no read is unknown', () => {
    const c = new StagingClock();
    expect(c.observe({ status: 'stopped', uptimeSec: 0 }, t).state.state).toBe('stopped');
    expect(c.observe(null, t).state.state).toBe('unknown');
  });
  test('alert text names the hours and the limit', () => {
    expect(alertText(20, 72_000)).toContain('shuts down at 24 hours');
  });
});
