/**
 * One Discord message per incident, and it survives a restart (PET-384).
 *
 * WHAT THIS REPLACES. messageCache remembered a monitor's message only so a recovery
 * could edit it. Every DOWN heartbeat still posted a fresh DM and overwrote the stored
 * id, orphaning the previous message — so a monitor on Uptime Kuma's resend interval
 * produced one DM per beat, and 19 monitors produced a channel you mute. A muted channel
 * is how the nine-and-a-half-hour Vault outage reached nobody (PET-374), which is the
 * failure this whole route exists to end. Posting the alert is not the job; being read is.
 *
 * THE MODEL. A batch is one posted message covering one or more monitors:
 *
 *   - A monitor already in an open batch never opens a second message. It edits.
 *   - A monitor that fails while a batch is still inside its coalescing window joins
 *     that batch, so a node reboot taking eight services down is one DM, not eight.
 *   - Past that window a failure opens its own message. That bound is deliberate: an
 *     edit to an old message raises no notification, so an unbounded window would let a
 *     new outage arrive silently — the precise failure being fixed here.
 *   - A batch closes when every monitor in it has recovered, freeing those names to
 *     open a fresh, notifying message next time.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../utils/index.js';

export interface MonitorState {
  since: number;
  checks: number;
  recoveredAt?: number;
}

export interface AlertBatch {
  id: string;
  channelId?: string;
  messageId?: string;
  openedAt: number;
  /** When a monitor last JOINED. The coalescing window measures storm growth. */
  lastAddedAt: number;
  monitors: Record<string, MonitorState>;
}

export interface DownOutcome {
  batch: AlertBatch;
  action: 'send' | 'edit';
}

export interface UpOutcome {
  batch: AlertBatch | null;
  action: 'send' | 'edit';
  closed: boolean;
}

/** A misbehaving sender must not be able to grow this without bound. */
const MAX_BATCHES = 5000;

let batches = new Map<string, AlertBatch>();
let batchOf = new Map<string, string>();
let persistWarned = false;

function statePath(): string {
  return config.alerts.statePath;
}

function newId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── disk ──────────────────────────────────────────────────────────────────────

function persist(): void {
  const path = statePath();
  if (!path) return;
  try {
    // Write-then-rename: a crash mid-write leaves the previous state intact rather
    // than a half-written file that fails to parse on the next boot.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, batches: [...batches.values()] }), 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    // Losing the file costs edit-in-place after a restart. It must never cost an alert,
    // so this warns once and the store keeps working from memory.
    if (!persistWarned) {
      persistWarned = true;
      logger.warn(`[alertStore] cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function load(): void {
  const path = statePath();
  if (!path || !existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { batches?: AlertBatch[] };
    for (const batch of parsed.batches ?? []) {
      batches.set(batch.id, batch);
      for (const [monitor, state] of Object.entries(batch.monitors)) {
        if (!state.recoveredAt) batchOf.set(monitor, batch.id);
      }
    }
    logger.info(`[alertStore] restored ${batches.size} open alert batches from ${path}`);
  } catch (err) {
    // A corrupt file must not stop the process that carries the alerts.
    logger.warn(`[alertStore] ignoring unreadable ${path}: ${err instanceof Error ? err.message : String(err)}`);
    batches = new Map();
    batchOf = new Map();
  }
}

load();

// ── eviction ──────────────────────────────────────────────────────────────────

function evictIfNeeded(): void {
  while (batches.size > MAX_BATCHES) {
    const oldest = batches.keys().next().value; // Map preserves insertion order
    if (!oldest) return;
    const batch = batches.get(oldest);
    batches.delete(oldest);
    for (const monitor of Object.keys(batch?.monitors ?? {})) {
      if (batchOf.get(monitor) === oldest) batchOf.delete(monitor);
    }
  }
}

// ── the two things the route asks ─────────────────────────────────────────────

export function recordDown(monitor: string, opts: { now?: number; windowMs?: number } = {}): DownOutcome {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? config.alerts.coalesceMs;

  const known = batchOf.get(monitor);
  const existing = known ? batches.get(known) : undefined;
  if (existing) {
    const state = existing.monitors[monitor]!;
    state.checks += 1;
    persist();
    // No messageId means the DM never landed — a 502 from Discord, most likely. Send
    // rather than edit, or a failed first attempt would silence the monitor for good.
    return { batch: existing, action: existing.messageId ? 'edit' : 'send' };
  }

  const candidate = windowMs > 0 ? openBatchWithin(now, windowMs) : undefined;
  if (candidate) {
    candidate.monitors[monitor] = { since: now, checks: 1 };
    candidate.lastAddedAt = now;
    batchOf.set(monitor, candidate.id);
    persist();
    return { batch: candidate, action: 'edit' };
  }

  const batch: AlertBatch = {
    id: newId(now),
    openedAt: now,
    lastAddedAt: now,
    monitors: { [monitor]: { since: now, checks: 1 } },
  };
  batches.set(batch.id, batch);
  batchOf.set(monitor, batch.id);
  evictIfNeeded();
  persist();
  return { batch, action: 'send' };
}

/** The newest batch that is still inside the window and has a message to edit. */
function openBatchWithin(now: number, windowMs: number): AlertBatch | undefined {
  let best: AlertBatch | undefined;
  for (const batch of batches.values()) {
    if (!batch.messageId) continue;
    if (now - batch.lastAddedAt > windowMs) continue;
    if (!best || batch.lastAddedAt > best.lastAddedAt) best = batch;
  }
  return best;
}

export function recordUp(monitor: string, opts: { now?: number } = {}): UpOutcome {
  const now = opts.now ?? Date.now();
  const known = batchOf.get(monitor);
  const batch = known ? batches.get(known) : undefined;

  // A recovery for something this process never saw fail — a restart, or Kuma's first
  // beat after an edit. Say so rather than dropping it.
  if (!batch) return { batch: null, action: 'send', closed: false };

  const state = batch.monitors[monitor]!;
  state.recoveredAt = now;
  batchOf.delete(monitor);

  const closed = Object.values(batch.monitors).every((m) => m.recoveredAt !== undefined);
  if (closed) batches.delete(batch.id);
  persist();

  return { batch, action: 'edit', closed };
}

export function attachMessage(batchId: string, channelId: string, messageId: string): void {
  const batch = batches.get(batchId);
  if (!batch) return;
  batch.channelId = channelId;
  batch.messageId = messageId;
  persist();
}

// ── inspection ────────────────────────────────────────────────────────────────

export function activeBatches(): AlertBatch[] {
  return [...batches.values()];
}

export function size(): number {
  return batches.size;
}

export function reset(): void {
  batches = new Map();
  batchOf = new Map();
  persistWarned = false;
  const path = statePath();
  if (path && existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* a stale file is harmless; it is overwritten by the next persist */
    }
  }
}
