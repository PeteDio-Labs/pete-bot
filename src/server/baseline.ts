/**
 * How long each monitor usually takes to come back inside a maintenance window (PET-492).
 *
 * The deadline for a held DOWN is mean plus one standard deviation, rounded up to the next
 * Kuma heartbeat, plus one heartbeat. Over the 14 nights to 2026-09-22 that raises no false
 * alert and still flags the 9.6-hour Vault outage within two minutes of the DOWN.
 *
 * The multiplier, the heartbeat and the minimum sample count are policy, not infrastructure
 * facts, so they are constants here rather than environment variables.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../utils/index.js';

const SIGMA = 1;
const HEARTBEAT_MS = 20_000;
const MIN_SAMPLES = 5;
const MAX_SAMPLES = 30;

let samples = new Map<string, number[]>();
let loadedFrom: string | undefined;

function path(): string {
  return config.alerts.baselinePath;
}

function persist(): void {
  const p = path();
  if (!p) return;
  try {
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, samples: Object.fromEntries(samples) }), 'utf8');
    renameSync(tmp, p);
  } catch (err) {
    logger.warn(`[baseline] cannot write ${p}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function load(): void {
  const p = path();
  loadedFrom = p;
  samples = new Map();
  if (!p || !existsSync(p)) return;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { samples?: Record<string, number[]> };
    for (const [monitor, list] of Object.entries(parsed.samples ?? {})) {
      samples.set(monitor, list.filter((n) => Number.isFinite(n) && n >= 0).slice(-MAX_SAMPLES));
    }
  } catch (err) {
    logger.warn(`[baseline] ignoring unreadable ${p}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function ensureLoaded(): void {
  if (loadedFrom !== path()) load();
}

/** A recovery inside its deadline. A recovery that missed it is an incident and is never added. */
export function addSample(monitor: string, recoveryMs: number): void {
  ensureLoaded();
  const list = [...(samples.get(monitor) ?? []), recoveryMs].slice(-MAX_SAMPLES);
  samples.set(monitor, list);
  persist();
}

export interface Stats {
  n: number;
  meanMs: number;
  sdMs: number;
}

export function stats(monitor: string): Stats | null {
  ensureLoaded();
  const list = samples.get(monitor) ?? [];
  if (list.length === 0) return null;
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  const variance = list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length;
  return { n: list.length, meanMs: mean, sdMs: Math.sqrt(variance) };
}

/** Under MIN_SAMPLES the cold-start deadline stands, which suppresses every ordinary night from the first deploy. */
export function deadlineMs(monitor: string): number {
  const s = stats(monitor);
  if (!s || s.n < MIN_SAMPLES) return config.alerts.maintenanceDeadlineMs;
  const raw = s.meanMs + SIGMA * s.sdMs;
  return Math.ceil(raw / HEARTBEAT_MS) * HEARTBEAT_MS + HEARTBEAT_MS;
}

export function resetBaseline(): void {
  samples = new Map();
  loadedFrom = undefined;
}
