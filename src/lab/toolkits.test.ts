import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { ALL_TOOLKITS, MEDIA_TOOLKITS, parseToolkits, selectMediaTools } from './toolkits.js';
import { MTRACE_SPECS } from './tools/mtrace.js';
import type { LabTool } from './tools/types.js';

const tool = (name: string): LabTool => ({ name, description: 'd', input: z.object({}), run: async () => ({ source: 's', data: {} }) });

describe('toolkits', () => {
  it('selects every kit when unset or blank', () => {
    expect(parseToolkits(undefined)).toEqual(ALL_TOOLKITS);
    expect(parseToolkits('  ')).toEqual(ALL_TOOLKITS);
  });
  it('sorts and dedupes a chosen set, and refuses a typo', () => {
    expect(parseToolkits('health, core,core')).toEqual(['core', 'health']);
    expect(() => parseToolkits('core,helth')).toThrow(/no such toolkit: helth/);
  });
  it('keeps only the tools of the chosen kits, in their original order', () => {
    const all = ['library', 'vpn_health', 'seerr_drift', 'propose_action', 'search_lab'].map(tool);
    expect([...selectMediaTools(all, ['core', 'audit']).keys()]).toEqual(['library', 'seerr_drift']);
  });
  it('refuses names that only exist on Object.prototype', () => {
    expect(() => parseToolkits('constructor')).toThrow(/no such toolkit/);
  });
  it('places the bazarr, search and propose tools in a kit', () => {
    const placed = Object.values(MEDIA_TOOLKITS).flat();
    for (const n of ['bazarr_status', 'bazarr_find', 'search_lab', 'propose_action']) expect(placed).toContain(n);
  });
  it('places every mtrace tool in exactly one kit', () => {
    const placed = Object.values(MEDIA_TOOLKITS).flat();
    expect(new Set(placed).size).toBe(placed.length);
    for (const s of MTRACE_SPECS) expect(placed).toContain(s.name);
  });
});
