import { describe, expect, it } from 'bun:test';
import { TRACERR_SPECS } from './tools/tracerr.js';
import { CASES } from './routingCases.js';

describe('routing eval cases', () => {
  it('expect only tools tracerr offers, and cover every media tool but the two broad ones', () => {
    const names = new Set(TRACERR_SPECS.map((s) => s.name));
    for (const c of CASES) for (const n of c.expect) expect(names.has(n)).toBe(true);
    const covered = new Set(CASES.flatMap((c) => c.expect));
    expect([...names].filter((n) => !covered.has(n))).toEqual(['partial_files']);
  });
});
