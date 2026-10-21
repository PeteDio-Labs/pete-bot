/** PET-492 — the deadline for a held DOWN. */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { addSample, deadlineMs, resetBaseline, stats } from './baseline.js';

const original = config.alerts.baselinePath;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pete-bot-baseline-'));
  config.alerts.baselinePath = join(dir, 'baseline.json');
  resetBaseline();
});

afterEach(() => {
  config.alerts.baselinePath = original;
  resetBaseline();
  rmSync(dir, { recursive: true, force: true });
});

describe('deadlineMs', () => {
  it('uses the cold-start deadline with no samples', () => {
    expect(deadlineMs('vault')).toBe(config.alerts.maintenanceDeadlineMs);
  });

  it('uses the cold-start deadline under 5 samples', () => {
    for (const s of [60_000, 70_000, 80_000, 70_000]) addSample('vault', s);
    expect(deadlineMs('vault')).toBe(config.alerts.maintenanceDeadlineMs);
  });

  it('is mean plus one SD, rounded up to a heartbeat, plus one heartbeat', () => {
    // mean 70 s, SD ~14.1 s: 84.1 s rounds up to 100 s, plus 20 s.
    for (const s of [50_000, 60_000, 70_000, 80_000, 90_000]) addSample('vault', s);
    expect(deadlineMs('vault')).toBe(120_000);
  });

  it('keeps the last 30 samples', () => {
    for (let i = 0; i < 40; i++) addSample('vault', 1000 * (i + 1));
    expect(stats('vault')?.n).toBe(30);
  });

  it('survives a restart through the file', () => {
    for (const s of [50_000, 60_000, 70_000, 80_000, 90_000]) addSample('vault', s);
    resetBaseline();
    expect(deadlineMs('vault')).toBe(120_000);
  });

  it('keeps working with no path configured', () => {
    config.alerts.baselinePath = '';
    resetBaseline();
    addSample('vault', 50_000);
    expect(stats('vault')?.n).toBe(1);
  });
});
