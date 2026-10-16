/**
 * What the merge desk remembers about each PR, across restarts (PET-645).
 *
 * ⚠ IT MUST OUTLIVE A RESTART. Without it, a deploy would queue a second Codex review of
 * a head already queued, and DM Pedro a second Merge button for a PR he already saw. The
 * desk refuses to start without a path; only tests pass ':memory:'.
 */
import { Database, type Statement } from 'bun:sqlite';
import type { PrMemory } from './decide.js';

export interface DeskMemory extends PrMemory {
  /** The head SHA a Merge button was sent for, so one head gets one DM. */
  askedSha?: string;
  /** The head SHA the two-round stop was reported for. */
  stopReportedSha?: string;
  /** The head SHA whose merge GitHub refused; the next attempt waits for a tap. */
  mergeFailedSha?: string;
  /** The merge commit, once the desk merged the PR. */
  mergedSha?: string;
}

export class DeskStore {
  private readonly db: Database;
  private readonly getStmt: Statement;
  private readonly putStmt: Statement;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS desk_prs (
        pr         TEXT PRIMARY KEY,
        memory     TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.getStmt = this.db.prepare('SELECT memory FROM desk_prs WHERE pr = ?');
    this.putStmt = this.db.prepare(
      'INSERT INTO desk_prs (pr, memory, updated_at) VALUES (?, ?, ?) ON CONFLICT(pr) DO UPDATE SET memory = excluded.memory, updated_at = excluded.updated_at',
    );
  }

  get(repo: string, n: number): DeskMemory {
    const row = this.getStmt.get(`${repo}#${n}`) as { memory: string } | null;
    return row ? (JSON.parse(row.memory) as DeskMemory) : {};
  }

  update(repo: string, n: number, change: Partial<DeskMemory>): DeskMemory {
    const next = { ...this.get(repo, n), ...change };
    this.putStmt.run(`${repo}#${n}`, JSON.stringify(next), new Date().toISOString());
    return next;
  }

  close(): void {
    this.getStmt.finalize();
    this.putStmt.finalize();
    this.db.close();
  }
}
