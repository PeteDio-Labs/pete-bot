/**
 * Event Deduplication
 *
 * Suppresses duplicate events within a configurable time window.
 * Keys on `source + type + affected_service + namespace`.
 */

export interface DedupEntry {
  key: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
}

export class EventDedup {
  private seen = new Map<string, DedupEntry>();
  private windowMs: number;
  private pruneIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
    this.pruneIntervalId = setInterval(() => this.prune(), this.windowMs);
  }

  /**
   * Build dedup key from event fields.
   */
  static buildKey(source: string, type: string, affectedService?: string, namespace?: string): string {
    return [source, type, affectedService ?? '', namespace ?? ''].join('|');
  }

  /**
   * Check if an event is a duplicate. If it is, increments the counter
   * and returns the entry. If not, creates a new entry and returns null.
   */
  isDuplicate(source: string, type: string, affectedService?: string, namespace?: string): DedupEntry | null {
    const key = EventDedup.buildKey(source, type, affectedService, namespace);
    const now = Date.now();
    const existing = this.seen.get(key);

    if (existing && now - existing.firstSeen < this.windowMs) {
      existing.count += 1;
      existing.lastSeen = now;
      return existing;
    }

    // New or expired entry
    this.seen.set(key, { key, count: 1, firstSeen: now, lastSeen: now });
    return null;
  }

  /**
   * Get the dedup entry for a key (for embed footer display).
   */
  getEntry(source: string, type: string, affectedService?: string, namespace?: string): DedupEntry | undefined {
    const key = EventDedup.buildKey(source, type, affectedService, namespace);
    return this.seen.get(key);
  }

  /**
   * Remove expired entries.
   */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.seen) {
      if (now - entry.firstSeen >= this.windowMs) {
        this.seen.delete(key);
      }
    }
  }

  /**
   * Clean up interval timer.
   */
  destroy(): void {
    if (this.pruneIntervalId) {
      clearInterval(this.pruneIntervalId);
      this.pruneIntervalId = null;
    }
    this.seen.clear();
  }

  get size(): number {
    return this.seen.size;
  }
}
