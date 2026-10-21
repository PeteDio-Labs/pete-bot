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
 *   - A recovery for a monitor whose DOWN was never seen folds into the open or most
 *     recent batch inside the window, or opens one batch that later orphans share (PET-436).
 *   - A DOWN that starts inside a maintenance window is held, not sent (PET-492). A hold
 *     is persisted beside the batches, and the route owns the deadline timer.
 */
import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../utils/index.js';

export interface MonitorState {
  since: number;
  checks: number;
  recoveredAt?: number;
  /** A recovery whose DOWN this process never saw (PET-436). It has no outage length. */
  unseenDown?: boolean;
  /** Extra line under the monitor, set when a held DOWN passed its deadline (PET-492). */
  note?: string;
}

/** A DOWN held inside a maintenance window, waiting for its UP or its deadline. */
export interface Hold {
  monitor: string;
  since: number;
  deadlineAt: number;
  window: string;
  /** The probe message from the DOWN, kept for the DM if the deadline passes. */
  detail: string;
  /** When the UP arrived after the deadline. The deadline DM is then followed by the recovery. */
  upAt?: number;
  /** The deadline DM went out. A retry then only closes the incident; it never sends the DOWN again. */
  announced?: boolean;
}

export interface AlertBatch {
  id: string;
  channelId?: string;
  messageId?: string;
  openedAt: number;
  /** When a monitor last JOINED. The coalescing window measures storm growth. */
  lastAddedAt: number;
  /** When a monitor last joined, recovered or folded in. Orphan recoveries measure the window from here. */
  lastActivityAt?: number;
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
let holds = new Map<string, Hold>();
/** Batches that have fully recovered, kept for the window so late orphan recoveries can edit them. Memory only. */
let recent = new Map<string, AlertBatch>();
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
    writeFileSync(tmp, JSON.stringify({ version: 1, batches: [...batches.values()], holds: [...holds.values()] }), 'utf8');
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
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { batches?: AlertBatch[]; holds?: Hold[] };
    for (const batch of parsed.batches ?? []) {
      batches.set(batch.id, batch);
      for (const [monitor, state] of Object.entries(batch.monitors)) {
        if (!state.recoveredAt) batchOf.set(monitor, batch.id);
      }
    }
    for (const hold of parsed.holds ?? []) holds.set(hold.monitor, hold);
    logger.info(`[alertStore] restored ${batches.size} open alert batches and ${holds.size} holds from ${path}`);
  } catch (err) {
    // A corrupt file must not stop the process that carries the alerts.
    logger.warn(`[alertStore] ignoring unreadable ${path}: ${err instanceof Error ? err.message : String(err)}`);
    batches = new Map();
    batchOf = new Map();
    holds = new Map();
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

export function recordDown(monitor: string, opts: { now?: number; windowMs?: number; since?: number } = {}): DownOutcome {
  const now = opts.now ?? Date.now();
  // A held DOWN passes the time it first failed, so the DM says how long it has been down.
  const since = opts.since ?? now;
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
    candidate.monitors[monitor] = { since, checks: 1 };
    candidate.lastAddedAt = now;
    candidate.lastActivityAt = now;
    batchOf.set(monitor, candidate.id);
    persist();
    return { batch: candidate, action: 'edit' };
  }

  const batch: AlertBatch = {
    id: newId(now),
    openedAt: now,
    lastAddedAt: now,
    monitors: { [monitor]: { since, checks: 1 } },
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
  batch.lastActivityAt = now;
  batchOf.delete(monitor);

  const closed = Object.values(batch.monitors).every((m) => m.recoveredAt !== undefined);
  if (closed) {
    batches.delete(batch.id);
    recent.set(batch.id, batch);
  }
  persist();

  return { batch, action: 'edit', closed };
}

/**
 * A recovery for a monitor whose DOWN this process never saw (PET-436). On 2026-09-15 four
 * monitors recovered with no DOWN on record and each posted its own DM beside the incident
 * message. Fold it into the newest batch, open or fully recovered, that was active inside the
 * window and has a message to edit. With none, open a batch holding only this recovery, so the
 * next orphan in the burst folds into it: one message per burst, not one per monitor.
 */
export function foldOrphanUp(monitor: string, opts: { now?: number; windowMs?: number } = {}): { batch: AlertBatch; isNew: boolean } {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? config.alerts.coalesceMs;
  prune(now, windowMs);

  let best: AlertBatch | undefined;
  if (windowMs > 0) {
    for (const batch of [...batches.values(), ...recent.values()]) {
      if (!batch.messageId) continue;
      if (now - (batch.lastActivityAt ?? batch.lastAddedAt) > windowMs) continue;
      if (!best || (batch.lastActivityAt ?? batch.lastAddedAt) > (best.lastActivityAt ?? best.lastAddedAt)) best = batch;
    }
  }
  if (best) {
    best.monitors[monitor] = { since: now, checks: 0, recoveredAt: now, unseenDown: true };
    best.lastActivityAt = now;
    persist();
    return { batch: best, isNew: false };
  }

  const batch: AlertBatch = {
    id: newId(now),
    openedAt: now,
    lastAddedAt: now,
    lastActivityAt: now,
    monitors: { [monitor]: { since: now, checks: 0, recoveredAt: now, unseenDown: true } },
  };
  recent.set(batch.id, batch);
  return { batch, isNew: true };
}

function prune(now: number, windowMs: number): void {
  for (const [id, batch] of recent) {
    if (now - (batch.lastActivityAt ?? batch.lastAddedAt) > windowMs) recent.delete(id);
  }
  while (recent.size > 100) {
    const oldest = recent.keys().next().value;
    if (!oldest) break;
    recent.delete(oldest);
  }
}

export function attachMessage(batchId: string, channelId: string, messageId: string): void {
  const batch = batches.get(batchId) ?? recent.get(batchId);
  if (!batch) return;
  batch.channelId = channelId;
  batch.messageId = messageId;
  persist();
}

// ── maintenance holds (PET-492) ───────────────────────────────────────────────

/**
 * Undoes a recordDown whose DM never went out, so the monitor is back to "down, unannounced".
 * Returns false when the monitor already recovered in the meantime, and the caller must not
 * restore anything for it.
 */
export function discardDown(monitor: string): boolean {
  const id = batchOf.get(monitor);
  const batch = id ? batches.get(id) : undefined;
  if (!id || !batch) return false;
  delete batch.monitors[monitor];
  batchOf.delete(monitor);
  if (Object.keys(batch.monitors).length === 0 && !batch.messageId) batches.delete(id);
  persist();
  return true;
}

/** True when a DOWN for this monitor is already inside an open batch, so it edits as always. */
export function isInBatch(monitor: string): boolean {
  return batchOf.has(monitor);
}

export function getHold(monitor: string): Hold | undefined {
  return holds.get(monitor);
}

export function addHold(hold: Hold): void {
  holds.set(hold.monitor, hold);
  persist();
}

/** Removes and returns the hold: for an UP before the deadline, or when the deadline passes. */
export function takeHold(monitor: string): Hold | undefined {
  const hold = holds.get(monitor);
  if (!hold) return undefined;
  holds.delete(monitor);
  persist();
  return hold;
}

/** Records an UP that arrived after the deadline, while the hold still waits for its DM. */
export function markHoldUp(monitor: string, at: number | undefined): boolean {
  const hold = holds.get(monitor);
  if (!hold) return false;
  if (at === undefined) delete hold.upAt;
  else hold.upAt = at;
  persist();
  return true;
}

/** The deadline DM exists. Persisted, so a retry after a failure never sends the DOWN twice. */
export function markHoldAnnounced(monitor: string): void {
  const hold = holds.get(monitor);
  if (!hold) return;
  hold.announced = true;
  persist();
}

export function activeHolds(): Hold[] {
  return [...holds.values()];
}

export function heldCount(): number {
  return holds.size;
}

/** Marks a monitor so the DM and every later edit say why the alert was late. */
export function setNote(batchId: string, monitor: string, note: string): void {
  const state = batches.get(batchId)?.monitors[monitor];
  if (!state) return;
  state.note = note;
  persist();
}

// ── inspection ────────────────────────────────────────────────────────────────

export function activeBatches(): AlertBatch[] {
  return [...batches.values()];
}

export function size(): number {
  return batches.size;
}

/** What a restart does: forget memory and read the state file again. Tests call it. */
export function restoreFromDisk(): void {
  batches = new Map();
  batchOf = new Map();
  holds = new Map();
  recent = new Map();
  persistWarned = false;
  load();
}

export function reset(): void {
  batches = new Map();
  batchOf = new Map();
  holds = new Map();
  recent = new Map();
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
