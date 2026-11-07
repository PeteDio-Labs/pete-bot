/**
 * The reports hub (PET-868): one folder per report kind under the dashboard's directory, one
 * JSON file per record. The weekly PR report keeps its flat files; every other kind (the daily
 * CVE check, Plane cycle progress, ...) saves through here, and the dashboard lists whatever
 * is stored.
 *
 * ⚠ A record says what it examined. The store keeps the record a kind wrote and adds nothing
 * to it, so a kind that stored "0 findings" must also have stored what it read.
 */
import type { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { openReportDb } from './db.js';

const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ID_RE = /^\d{4}-\d{2}-\d{2}(-[a-z0-9]{1,16})?$/;
/** The most records one feed returns, newest first. */
export const FEED_LIMIT = 120;

/** Every hub record carries its id (a date, optionally with a suffix) and when it was built. */
export interface HubRecord {
  id: string;
  generatedAt: string;
  [field: string]: unknown;
}

export interface KindInfo {
  kind: string;
  count: number;
  newest: string | null;
}

export class ReportHub {
  private readonly db: Database;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = openReportDb(dir);
  }

  private checkKind(kind: string): string {
    if (!KIND_RE.test(kind)) throw new Error(`bad report kind "${kind}"`);
    return kind;
  }

  save(kind: string, rec: HubRecord): void {
    if (!ID_RE.test(rec.id)) throw new Error(`bad record id "${rec.id}"`);
    this.checkKind(kind);
    this.db.query('INSERT INTO hub (kind, id, body) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body').run(kind, rec.id, JSON.stringify(rec));
  }

  private ids(kind: string): string[] {
    return (this.db.query('SELECT id FROM hub WHERE kind = ? ORDER BY id DESC').all(this.checkKind(kind)) as { id: string }[]).map((r) => r.id);
  }

  /** One record, or null when it is absent or cannot be read. */
  get(kind: string, id: string): HubRecord | null {
    if (!ID_RE.test(id)) return null;
    const row = this.db.query('SELECT body FROM hub WHERE kind = ? AND id = ?').get(this.checkKind(kind), id) as { body: string } | null;
    if (!row) return null;
    try {
      return JSON.parse(row.body) as HubRecord;
    } catch {
      return null;
    }
  }

  has(kind: string, id: string): boolean {
    return this.ids(kind).includes(id);
  }

  /** The kinds that hold records, with how many each holds. */
  kinds(): KindInfo[] {
    const rows = this.db.query('SELECT kind, COUNT(*) AS count, MAX(id) AS newest FROM hub GROUP BY kind ORDER BY kind').all() as { kind: string; count: number; newest: string | null }[];
    return rows.filter((r) => KIND_RE.test(r.kind) && r.count > 0).map((r) => ({ kind: r.kind, count: r.count, newest: r.newest }));
  }

  /** The newest records of a kind, newest first. A record that cannot be read is named, not skipped. */
  list(kind: string): { records: HubRecord[]; unreadable: string[] } {
    const records: HubRecord[] = [];
    const unreadable: string[] = [];
    for (const id of this.ids(kind).slice(0, FEED_LIMIT)) {
      const rec = this.get(kind, id);
      if (rec) records.push(rec);
      else unreadable.push(id);
    }
    return { records, unreadable };
  }
}
