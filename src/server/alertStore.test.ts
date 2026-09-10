/**
 * PET-384 UC-1, UC-5, UC-7 — one message per incident, and it survives a restart.
 *
 * The old messageCache remembered a monitor's message only so an UP could edit it. A
 * repeat DOWN posted a fresh DM and overwrote the id, orphaning the first — so a monitor
 * on Kuma's resend interval produced a message per heartbeat, and across 19 monitors
 * that is a channel you mute. A muted channel is how the nine-hour Vault outage reached
 * nobody, which is the failure this whole route exists to end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordDown, recordUp, attachMessage, activeBatches, size, reset } from './alertStore.js';

const WINDOW = 60_000;
const T0 = 1_700_000_000_000;

beforeEach(() => reset());

/** A DOWN that has been posted, so the batch has a message to edit. */
function down(monitor: string, now: number) {
  const outcome = recordDown(monitor, { now, windowMs: WINDOW });
  if (outcome.action === 'send') attachMessage(outcome.batch.id, 'dm-1', `msg-${outcome.batch.id}`);
  return outcome;
}

describe('a monitor that is still down', () => {
  it('sends once and edits thereafter', () => {
    expect(down('vault', T0).action).toBe('send');
    expect(down('vault', T0 + 60_000).action).toBe('edit');
    expect(down('vault', T0 + 120_000).action).toBe('edit');
  });

  it('never opens a second message, even hours later', () => {
    down('vault', T0);
    const late = down('vault', T0 + 9 * 60 * 60 * 1000);
    expect(late.action).toBe('edit');
    expect(activeBatches()).toHaveLength(1);
  });

  it('counts the heartbeats so the message can say how long', () => {
    down('vault', T0);
    down('vault', T0 + 60_000);
    const third = down('vault', T0 + 120_000);
    expect(third.batch.monitors.vault).toMatchObject({ since: T0, checks: 3 });
  });

  it('edits the message it actually posted', () => {
    const first = down('vault', T0);
    const second = down('vault', T0 + 60_000);
    expect(second.batch.messageId).toBe(first.batch.messageId);
    expect(second.batch.messageId).toBeTruthy();
  });
});

describe('a storm', () => {
  it('folds monitors that fall inside the window into one message', () => {
    expect(down('vault', T0).action).toBe('send');
    expect(down('zot', T0 + 2_000).action).toBe('edit');
    expect(down('plex', T0 + 5_000).action).toBe('edit');
    expect(activeBatches()).toHaveLength(1);
    expect(Object.keys(activeBatches()[0]!.monitors).sort()).toEqual(['plex', 'vault', 'zot']);
  });

  it('gives a later, unrelated failure its own message, so it still notifies', () => {
    down('vault', T0);
    const later = down('sonarr', T0 + WINDOW + 1);
    expect(later.action).toBe('send');
    expect(activeBatches()).toHaveLength(2);
  });

  it('keeps the window open while the storm is still growing', () => {
    down('vault', T0);
    down('zot', T0 + 50_000);
    expect(down('plex', T0 + 95_000).action).toBe('edit');
  });

  it('does not coalesce when the window is disabled', () => {
    recordDown('vault', { now: T0, windowMs: 0 });
    const second = recordDown('zot', { now: T0 + 10, windowMs: 0 });
    expect(second.action).toBe('send');
  });
});

describe('recovery', () => {
  it('edits the batch that carried the outage', () => {
    down('vault', T0);
    const up = recordUp('vault', { now: T0 + 300_000 });
    expect(up.action).toBe('edit');
    expect(up.batch?.monitors.vault?.recoveredAt).toBe(T0 + 300_000);
  });

  it('keeps the batch open while anything in it is still down', () => {
    down('vault', T0);
    down('zot', T0 + 1_000);
    const up = recordUp('vault', { now: T0 + 60_000 });
    expect(up.closed).toBe(false);
    expect(activeBatches()).toHaveLength(1);
  });

  it('closes the batch once every monitor in it recovers', () => {
    down('vault', T0);
    down('zot', T0 + 1_000);
    recordUp('vault', { now: T0 + 60_000 });
    const last = recordUp('zot', { now: T0 + 61_000 });
    expect(last.closed).toBe(true);
    expect(activeBatches()).toHaveLength(0);
  });

  it('lets a monitor that recovered and failed again open a fresh message', () => {
    down('vault', T0);
    recordUp('vault', { now: T0 + 60_000 });
    expect(down('vault', T0 + 3 * WINDOW).action).toBe('send');
  });

  it('posts a standalone message for a recovery it never saw fail', () => {
    const up = recordUp('mystery', { now: T0 });
    expect(up.action).toBe('send');
    expect(up.batch).toBeNull();
  });
});

// ── UC-5: survive a restart ───────────────────────────────────────────────────
describe('persistence', () => {
  let dir: string;
  let statePath: string;
  const original = process.env.ALERT_STATE_PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pete-bot-alerts-'));
    statePath = join(dir, 'alerts.json');
    process.env.ALERT_STATE_PATH = statePath;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.ALERT_STATE_PATH;
    else process.env.ALERT_STATE_PATH = original;
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  async function freshStore() {
    vi.resetModules();
    return import('./alertStore.js');
  }

  it('still edits the DOWN message after a restart', async () => {
    const before = await freshStore();
    const opened = before.recordDown('vault', { now: T0, windowMs: WINDOW });
    before.attachMessage(opened.batch.id, 'dm-1', 'msg-42');
    expect(existsSync(statePath)).toBe(true);

    const after = await freshStore();
    const up = after.recordUp('vault', { now: T0 + 300_000 });
    expect(up.action).toBe('edit');
    expect(up.batch?.messageId).toBe('msg-42');
  });

  it('carries the heartbeat count across the restart', async () => {
    const before = await freshStore();
    const opened = before.recordDown('vault', { now: T0, windowMs: WINDOW });
    before.attachMessage(opened.batch.id, 'dm-1', 'msg-42');
    before.recordDown('vault', { now: T0 + 60_000, windowMs: WINDOW });

    const after = await freshStore();
    const next = after.recordDown('vault', { now: T0 + 120_000, windowMs: WINDOW });
    expect(next.action).toBe('edit');
    expect(next.batch.monitors.vault?.checks).toBe(3);
  });

  it('starts empty rather than crashing on a corrupt state file', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(statePath, '{not json');
    const after = await freshStore();
    expect(after.size()).toBe(0);
    expect(after.recordDown('vault', { now: T0, windowMs: WINDOW }).action).toBe('send');
  });

  it('keeps working when the state path cannot be written', async () => {
    process.env.ALERT_STATE_PATH = join(dir, 'no-such-dir', 'nested', 'alerts.json');
    const store = await freshStore();
    expect(() => store.recordDown('vault', { now: T0, windowMs: WINDOW })).not.toThrow();
  });

  it('holds nothing on disk when no state path is configured', async () => {
    delete process.env.ALERT_STATE_PATH;
    const store = await freshStore();
    store.recordDown('vault', { now: T0, windowMs: WINDOW });
    expect(existsSync(statePath)).toBe(false);
    expect(store.size()).toBe(1);
  });
});

describe('bounds', () => {
  it('does not grow without limit', () => {
    for (let i = 0; i < 6000; i++) down(`monitor-${i}`, T0 + i * (WINDOW + 1));
    expect(size()).toBeLessThanOrEqual(5000);
  });
});
