/**
 * The last key list pete-bot read, kept so the dashboard feed can show it without starting a run (staging reads the feed
 * and never the key manager). One JSON file beside the report store: names, owners and dates only, as parseKeyList returns
 * them. A file that is missing or does not parse reads as "never read", never as an empty list.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyList } from './list.js';

export interface KeysSnapshot {
  list: KeyList;
  /** When the list was read, as an ISO time. */
  at: string;
}

export class KeysCache {
  private last: KeysSnapshot | null = null;
  private readonly file: string | null;
  constructor(dir?: string) {
    this.file = dir ? join(dir, 'keys-list.json') : null;
    if (this.file) {
      try {
        const s = JSON.parse(readFileSync(this.file, 'utf8')) as KeysSnapshot;
        if (s && typeof s.at === 'string' && Number.isFinite(Date.parse(s.at)) && Array.isArray(s.list?.rows)) this.last = s;
      } catch {
        // Missing or unreadable: never read.
      }
    }
  }

  get(): KeysSnapshot | null {
    return this.last;
  }

  /** Keeps the list in memory first, so a disk that cannot be written still serves this process. Returns false when the file was not written. */
  set(list: KeyList, at: Date): boolean {
    this.last = { list, at: at.toISOString() };
    if (!this.file) return true;
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.last));
      renameSync(tmp, this.file);
      return true;
    } catch {
      return false;
    }
  }
}
