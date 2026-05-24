/**
 * Plan Expiry Sweep (PB.8).
 *
 * Background job that periodically polls MC Backend for plans that were
 * 'presented' to Discord but whose expires_at has lapsed without a click.
 * For each such plan we:
 *   1. Strip the action buttons from the Discord message (so a late click
 *      no longer fires).
 *   2. Append an "Expired" note to the embed so the user knows the plan
 *      is no longer actionable and can re-open it from MC.
 *   3. Drop the cache entry so the message slot is freed.
 *
 * MC Backend's GET /api/v1/plans/expired-presented also LAZILY transitions
 * each returned plan from 'presented' to 'expired' before responding, so
 * the next sweep won't return the same row again (it no longer matches
 * status='presented'). Both halves are idempotent — re-stripping buttons
 * on the same message is a no-op, and the state machine rejects
 * presented→expired the second time.
 *
 * Cache-miss handling: if a Pete Bot restart wiped messageCache between
 * the post and the sweep, we log + skip + bump the 'no_cache' metric.
 * RETRO.23 tracks persisting the cache so restarts don't lose the link.
 *
 * Errors per-plan are caught so one bad message can't break the sweep
 * for the rest of the batch.
 */

import type { Client, TextChannel } from 'discord.js';
import { logger } from '../utils/index.js';
import { lookupMessage, forgetMessage } from '../server/messageCache.js';
import { expirySweepProcessed, expirySweepTicks } from '../metrics/index.js';

// ─── Constants ─────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_LIMIT = 50;
const EXPIRED_NOTE = 'Expired — re-open from MC';

// ─── Plan row shape (subset of PlanRow that we care about) ─────────────
// Mirror of what MC Backend's listExpiredPresented() returns. Kept loose
// because Pete Bot doesn't need the full row, only the id (for cache
// lookup) and a couple of fields for the embed update.

interface ExpiredPlan {
  id: string;
  kind?: string;
  summary?: string;
  expires_at?: string | null;
}

interface ExpiredPresentedResponse {
  plans: ExpiredPlan[];
}

// ─── Public API ────────────────────────────────────────────────────────

export interface StartExpirySweepOpts {
  mcBackendUrl: string;
  intervalMs?: number;
}

export function startExpirySweep(client: Client, opts: StartExpirySweepOpts): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const url = `${opts.mcBackendUrl.replace(/\/$/, '')}/api/v1/plans/expired-presented?limit=${FETCH_LIMIT}`;

  logger.info('[ExpirySweep] Starting', { intervalMs, url });

  const tick = async (): Promise<void> => {
    try {
      const plans = await fetchExpiredPresented(url);
      expirySweepTicks.inc({ status: 'ok' });
      if (plans.length === 0) {
        logger.debug('[ExpirySweep] No expired-presented plans');
        return;
      }
      logger.info('[ExpirySweep] Handling expired plans', { count: plans.length });
      for (const plan of plans) {
        await handleExpiredPlan(client, plan);
      }
    } catch (err) {
      expirySweepTicks.inc({ status: 'error' });
      logger.error('[ExpirySweep] Tick failed', { error: (err as Error).message });
    }
  };

  // Fire once immediately so a fresh restart catches any plans that
  // already expired while Pete Bot was down. Then run on interval.
  void tick();

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  // Don't keep the event loop alive on shutdown — this is a background
  // chore, not a primary responsibility.
  timer.unref();

  return timer;
}

// ─── Per-plan handler ──────────────────────────────────────────────────

async function handleExpiredPlan(client: Client, plan: ExpiredPlan): Promise<void> {
  const cached = lookupMessage(plan.id);
  if (!cached) {
    // RETRO.23: messageCache is in-memory, so a Pete Bot restart between
    // the Discord post and the expiry sweep means we can't edit the
    // original. The plan is already transitioned to 'expired' in the DB
    // (MC did that lazily during the GET), so functionally the user is
    // safe — the stale buttons will fail the click callback with
    // 'plan_closed' (410). Just log + skip.
    expirySweepProcessed.inc({ outcome: 'no_cache' });
    logger.warn('[ExpirySweep] No cache entry — buttons will rely on plan_closed rejection', {
      planId: plan.id,
    });
    return;
  }

  let channel: TextChannel;
  try {
    const fetched = await client.channels.fetch(cached.channelId);
    if (!fetched || !fetched.isTextBased() || fetched.isDMBased()) {
      expirySweepProcessed.inc({ outcome: 'discord_failed' });
      logger.warn('[ExpirySweep] Channel not a guild text channel — dropping cache', {
        planId: plan.id,
        channelId: cached.channelId,
      });
      forgetMessage(plan.id);
      return;
    }
    channel = fetched as TextChannel;
  } catch (err) {
    expirySweepProcessed.inc({ outcome: 'discord_failed' });
    logger.error('[ExpirySweep] Failed to fetch channel', {
      planId: plan.id,
      channelId: cached.channelId,
      error: (err as Error).message,
    });
    return;
  }

  try {
    const message = await channel.messages.fetch(cached.messageId);
    if (!message) {
      // Message gone — nothing to edit, drop the cache slot.
      forgetMessage(plan.id);
      expirySweepProcessed.inc({ outcome: 'discord_failed' });
      logger.warn('[ExpirySweep] Message not found in channel — dropping cache', {
        planId: plan.id,
      });
      return;
    }

    // Preserve any existing embed and append/replace an "Expired" field.
    // Idempotent: if the sweep already ran once and a previous tick added
    // the field, we replace in place rather than stacking duplicates.
    const embeds = message.embeds.length
      ? message.embeds.map((e) => {
          const data = e.toJSON();
          const fields = (data.fields ?? []).slice();
          const idx = fields.findIndex((f) => f.name === 'Status');
          const statusField = { name: 'Status', value: 'expired', inline: true };
          if (idx >= 0) fields[idx] = statusField;
          else fields.push(statusField);

          const idxNote = fields.findIndex((f) => f.name === 'Note');
          const noteField = { name: 'Note', value: EXPIRED_NOTE, inline: false };
          if (idxNote >= 0) fields[idxNote] = noteField;
          else fields.push(noteField);

          return { ...data, fields };
        })
      : message.embeds;

    await message.edit({
      embeds,
      // message.edit({ components: [] }) is idempotent — running it on a
      // message that already has zero components is a no-op POST that
      // Discord accepts silently.
      components: [],
    });

    forgetMessage(plan.id);
    expirySweepProcessed.inc({ outcome: 'edited' });
    logger.info('[ExpirySweep] Plan message expired in Discord', {
      planId: plan.id,
      channelId: channel.id,
      messageId: message.id,
    });
  } catch (err) {
    expirySweepProcessed.inc({ outcome: 'discord_failed' });
    logger.error('[ExpirySweep] Failed to edit Plan message', {
      planId: plan.id,
      error: (err as Error).message,
    });
  }
}

// ─── HTTP helper ───────────────────────────────────────────────────────

async function fetchExpiredPresented(url: string): Promise<ExpiredPlan[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`MC backend returned ${resp.status}`);
    }
    const body = (await resp.json()) as ExpiredPresentedResponse;
    if (!body || !Array.isArray(body.plans)) {
      throw new Error('MC backend response missing plans[]');
    }
    return body.plans;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`fetchExpiredPresented: timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
