/**
 * The gateway's spend ledger: one row per answered request (PET-617).
 *
 * WHY node:sqlite AND NOT bun:sqlite. The deploy runs pete-bot as a Bun binary, but
 * vitest runs the suite under Node, where `bun:sqlite` does not load. `node:sqlite` loads
 * under both, and in the compiled binary, so the tests exercise the same database code
 * that ships. It needs Node 22.5 or later, which is why CI sets up Node 22.
 *
 * ⚠ THE CAP READS THIS FILE, SO IT MUST OUTLIVE A RESTART. An in-memory ledger would
 * reset every caller's spend to zero on each deploy. The gateway refuses to start
 * without a ledger path; only tests pass ':memory:'.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export interface LedgerEntry {
  caller: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costNanoUsd: number;
  requestId?: string;
}

/** The UTC calendar month a timestamp falls in, as `YYYY-MM`. Caps reset on the 1st. */
export function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

export class Ledger {
  private readonly db: DatabaseSync;
  private readonly insert: StatementSync;
  private readonly spent: StatementSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS llm_usage (
        id                 INTEGER PRIMARY KEY,
        at                 TEXT    NOT NULL,
        month              TEXT    NOT NULL,
        caller             TEXT    NOT NULL,
        model              TEXT    NOT NULL,
        input_tokens       INTEGER NOT NULL,
        output_tokens      INTEGER NOT NULL,
        cache_read_tokens  INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        cost_nano_usd      INTEGER NOT NULL,
        request_id         TEXT
      );
      CREATE INDEX IF NOT EXISTS llm_usage_caller_month ON llm_usage (caller, month);
    `);
    this.insert = this.db.prepare(`
      INSERT INTO llm_usage (at, month, caller, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_nano_usd, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.spent = this.db.prepare(
      'SELECT COALESCE(SUM(cost_nano_usd), 0) AS total FROM llm_usage WHERE caller = ? AND month = ?',
    );
  }

  record(entry: LedgerEntry, at = new Date()): void {
    this.insert.run(
      at.toISOString(),
      monthOf(at),
      entry.caller,
      entry.model,
      entry.inputTokens,
      entry.outputTokens,
      entry.cacheReadTokens,
      entry.cacheWriteTokens,
      entry.costNanoUsd,
      entry.requestId ?? null,
    );
  }

  /** What a caller has spent in the month `at` falls in, in nano-dollars. */
  spentNanoUsd(caller: string, at = new Date()): number {
    const row = this.spent.get(caller, monthOf(at)) as { total: number | bigint };
    return Number(row.total);
  }

  close(): void {
    this.db.close();
  }
}
