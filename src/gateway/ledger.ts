/**
 * The gateway's spend ledger: one row per answered request (PET-617).
 *
 * WHY bun:sqlite. pete-bot runs under Bun alone: the service is a compiled Bun binary,
 * and `bun test` runs the suite, so the tests exercise the same database code that ships.
 * The first draft used `node:sqlite` for vitest under Node, and Bun 1.3.11 has no such
 * module, so that binary crashed at startup with the gateway off.
 *
 * ⚠ THE CAP READS THIS FILE, SO IT MUST OUTLIVE A RESTART. An in-memory ledger would
 * reset every caller's spend to zero on each deploy. The gateway refuses to start
 * without a ledger path; only tests pass ':memory:'.
 */
import { Database, type Statement } from 'bun:sqlite';

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

/** One caller and model's totals for a month, in nano-dollars and tokens. */
export interface MonthTotal {
  caller: string;
  model: string;
  costNanoUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export class Ledger {
  private readonly db: Database;
  private readonly insert: Statement;
  private readonly spent: Statement;
  private readonly totals: Statement;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
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
    this.totals = this.db.prepare(`
      SELECT caller, model,
        COALESCE(SUM(cost_nano_usd), 0)      AS cost,
        COALESCE(SUM(input_tokens), 0)       AS input,
        COALESCE(SUM(output_tokens), 0)      AS output,
        COALESCE(SUM(cache_read_tokens), 0)  AS cache_read,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write
      FROM llm_usage WHERE month = ? GROUP BY caller, model
    `);
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
    const row = this.spent.get(caller, monthOf(at)) as { total: number | bigint } | null;
    return Number(row?.total ?? 0);
  }

  /** Every caller and model's totals in the month `at` falls in. Feeds the Prometheus gauges (PET-711). */
  monthTotals(at = new Date()): MonthTotal[] {
    const rows = this.totals.all(monthOf(at)) as Array<Record<string, string | number | bigint>>;
    return rows.map((r) => ({
      caller: String(r.caller),
      model: String(r.model),
      costNanoUsd: Number(r.cost),
      inputTokens: Number(r.input),
      outputTokens: Number(r.output),
      cacheReadTokens: Number(r.cache_read),
      cacheWriteTokens: Number(r.cache_write),
    }));
  }

  /**
   * bun:sqlite keeps a database open while a prepared statement holds it, so the
   * statements are finalized first. After close, every read and write throws.
   */
  close(): void {
    this.insert.finalize();
    this.spent.finalize();
    this.totals.finalize();
    this.db.close();
  }
}
