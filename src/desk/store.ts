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
  /**
   * Reports the desk still owes the PR and Pedro: a merge, a failed merge or a failed queue.
   * Each is saved before it is sent, and each part is cleared once it lands, so a failed
   * send is retried on a later poll, even after the PR closed and is no longer listed.
   */
  outbox?: Outgoing[];
}

export interface Outgoing {
  id: string;
  comment?: string;
  dm?: string;
  buttons?: { customId: string; label: string; style: 'primary' | 'secondary' | 'danger' }[];
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

  /** Every PR the desk remembers, for the checks that don't start from an open PR. */
  entries(): { repo: string; n: number; memory: DeskMemory }[] {
    const rows = this.db.query('SELECT pr, memory FROM desk_prs').all() as { pr: string; memory: string }[];
    return rows.map((r) => {
      const at = r.pr.lastIndexOf('#');
      return { repo: r.pr.slice(0, at), n: Number(r.pr.slice(at + 1)), memory: JSON.parse(r.memory) as DeskMemory };
    });
  }

  close(): void {
    this.getStmt.finalize();
    this.putStmt.finalize();
    this.db.close();
  }
}
