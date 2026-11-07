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

/** One head the fallback judged or merged (PET-751). The record that shows whether Qwen holds up. */
export interface LedgerRow {
  id: number;
  repo: string;
  pr: number;
  sha: string;
  tier: number;
  /** 'qwen' for a tier 1 head, 'ci' for a tier 0 head merged on checks alone. */
  by: 'qwen' | 'ci';
  /** Qwen's word, or 'none' for a CI-only head. */
  verdict: string;
  judgedAt: string;
  mergedSha: string | null;
  mergedAt: string | null;
  /** Null until a check has run; 'reverted' once a later commit on the default branch reverts it. */
  outcome: 'reverted' | 'held' | null;
}

export class DeskStore {
  private readonly db: Database;
  private readonly getStmt: Statement;
  private readonly putStmt: Statement;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS qwen_ledger (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        repo      TEXT NOT NULL,
        pr        INTEGER NOT NULL,
        sha       TEXT NOT NULL,
        tier      INTEGER NOT NULL,
        by        TEXT NOT NULL,
        verdict   TEXT NOT NULL,
        judged_at TEXT NOT NULL,
        merged_sha TEXT,
        merged_at TEXT,
        outcome   TEXT,
        UNIQUE (repo, pr, sha, by)
      );
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

  /** Records a verdict on a head. A second verdict for the same head and lane replaces the first. */
  ledgerJudge(row: { repo: string; pr: number; sha: string; tier: number; by: 'qwen' | 'ci'; verdict: string }): void {
    this.db
      .query(
        `INSERT INTO qwen_ledger (repo, pr, sha, tier, by, verdict, judged_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, pr, sha, by) DO UPDATE SET verdict = excluded.verdict, judged_at = excluded.judged_at`,
      )
      .run(row.repo, row.pr, row.sha, row.tier, row.by, row.verdict, new Date().toISOString());
  }

  /** Marks the head the desk merged under a fallback lane. Creates the row if no verdict was stored. */
  ledgerMerged(row: { repo: string; pr: number; sha: string; tier: number; by: 'qwen' | 'ci'; mergedSha: string }): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO qwen_ledger (repo, pr, sha, tier, by, verdict, judged_at, merged_sha, merged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, pr, sha, by) DO UPDATE SET merged_sha = excluded.merged_sha, merged_at = excluded.merged_at`,
      )
      .run(row.repo, row.pr, row.sha, row.tier, row.by, row.by === 'ci' ? 'none' : 'clean', now, row.mergedSha, now);
  }

  /** Fallback merges not yet judged by a later outcome. A query, so the poll never loads the whole table. */
  ledgerOpen(): LedgerRow[] {
    return this.ledger('WHERE merged_at IS NOT NULL AND outcome IS NULL');
  }

  /** The Qwen rows for one PR. A query with parameters, so the poll never loads the whole table. */
  ledgerForPr(repo: string, pr: number): LedgerRow[] {
    const rows = this.ledger('WHERE by = ? AND repo = ? AND pr = ?', ['qwen', repo, pr]);
    return rows;
  }

  ledgerOutcome(id: number, outcome: 'reverted' | 'held'): void {
    this.db.query('UPDATE qwen_ledger SET outcome = ? WHERE id = ?').run(outcome, id);
  }

  ledger(where = '', params: (string | number)[] = []): LedgerRow[] {
    const rows = this.db.query(`SELECT * FROM qwen_ledger ${where} ORDER BY id DESC`).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      repo: r.repo as string,
      pr: r.pr as number,
      sha: r.sha as string,
      tier: r.tier as number,
      by: r.by as 'qwen' | 'ci',
      verdict: r.verdict as string,
      judgedAt: r.judged_at as string,
      mergedSha: (r.merged_sha as string | null) ?? null,
      mergedAt: (r.merged_at as string | null) ?? null,
      outcome: (r.outcome as 'reverted' | 'held' | null) ?? null,
    }));
  }

  close(): void {
    this.getStmt.finalize();
    this.putStmt.finalize();
    this.db.close();
  }
}
