/**
 * Characterization tests for the footer. These lock in what already ships so the
 * paging work in PET-384 cannot quietly change it.
 */
import { describe, it, expect } from 'vitest';
import { footer } from './footer.js';

describe('footer', () => {
  it('returns undefined when there is nothing to say', () => {
    expect(footer()).toBeUndefined();
    expect(footer(undefined, {})).toBeUndefined();
  });

  it('names the router on its own', () => {
    expect(footer('keyword')).toBe('routed by keyword');
  });

  it('shows both halves, because they fail for different reasons', () => {
    expect(footer('keyword', { routeMs: 1, toolMs: 6770, totalMs: 6771 })).toBe(
      'routed by keyword · 6.8s (route 1ms, tool 6770ms)',
    );
  });

  it('reports sub-second totals in milliseconds', () => {
    expect(footer(undefined, { totalMs: 240 })).toBe('240ms');
  });

  it('omits the breakdown when mtrace sent no split', () => {
    expect(footer('ollama', { totalMs: 4200 })).toBe('routed by ollama · 4.2s');
  });

  it('ignores a split with no total rather than inventing one', () => {
    expect(footer('ollama', { routeMs: 5 })).toBe('routed by ollama');
  });
});
