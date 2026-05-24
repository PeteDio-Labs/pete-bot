/**
 * In-memory Plan → posted-message cache (PB.6).
 *
 * When POST /v1/notify lands a Discord message, we record the channelId +
 * messageId keyed by planId. POST /v1/edit-message looks up that pair to
 * edit the same message in place.
 *
 * Why in-memory: simpler than a DB. The cache is reconstructable — Pete Bot
 * can ask MC for active plans on startup and re-discover them by querying the
 * channel's recent messages. For v2 we accept "message edits stop working
 * after a Pete Bot restart" until that recovery path lands (PB.8+).
 *
 * Followup retro candidate: persist cache to disk (sqlite or a JSON file on
 * the existing emptyDir volume) so restarts don't drop edit ability.
 */

import { logger } from '../utils/index.js';

interface CachedMessage {
  channelId: string;
  messageId: string;
  postedAt: number;
}

const cache = new Map<string, CachedMessage>();

// Hard cap on entries so a misbehaving caller can't OOM us. Plans that fall
// off are unrecoverable for edit-message; new plans always win.
const MAX_ENTRIES = 5000;

export function rememberMessage(planId: string, channelId: string, messageId: string): void {
  if (cache.size >= MAX_ENTRIES) {
    // Evict oldest (Map preserves insertion order)
    const oldest = cache.keys().next().value;
    if (oldest) {
      cache.delete(oldest);
      logger.debug('[messageCache] Evicted oldest entry', { evictedPlanId: oldest });
    }
  }
  cache.set(planId, { channelId, messageId, postedAt: Date.now() });
}

export function lookupMessage(planId: string): CachedMessage | undefined {
  return cache.get(planId);
}

export function forgetMessage(planId: string): boolean {
  return cache.delete(planId);
}

export function cacheSize(): number {
  return cache.size;
}
