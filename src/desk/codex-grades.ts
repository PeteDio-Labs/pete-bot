/**
 * Codex's grades of Qwen's fallback verdicts, in a store of their own (PET-899).
 *
 * ⚠ NOTHING THAT BUILDS A QWEN PROMPT MAY READ THIS FILE. OpenAI's terms bar using Codex
 * output to develop competing models, and the usage policies name rubrics and training
 * feedback. Codex may evaluate Qwen; its grades, comments and verdicts must never reach
 * Qwen's prompt, rubric, few-shot examples or training data, directly or through Claude.
 * So the grades live in a separate SQLite file (`DESK_CODEX_GRADES_PATH`), and
 * `codex-grades.test.ts` fails if `qwen.ts`, `decide.ts` or `store.ts` import this module.
 * Only the desk records into it, and only a person reads the summary.
 */
import { Database } from 'bun:sqlite';
import type { Verdict } from './codex.js';

export type Agreement = 'agree' | 'disagree' | 'ungradeable';

/**
 * Compares Qwen's word with Codex's verdict on the same head. Qwen `clean` agrees with Codex
 * `no-blocking`; Qwen `block` agrees with `changes-requested` and `escalate`. Any other Qwen
 * word (`unreadable`, `too-large`) says nothing to grade.
 */
export function agreement(qwen: string, codex: Verdict): Agreement {
  if (qwen === 'clean') return codex === 'no-blocking' ? 'agree' : 'disagree';
  if (qwen === 'block') return codex === 'no-blocking' ? 'disagree' : 'agree';
  return 'ungradeable';
}

export interface GradeSummary {
  graded: number;
  agree: number;
  disagree: number;
  /** Qwen `clean` where Codex found blocking issues: the costly miss. */
  missed: number;
  since: string | null;
}

export class CodexGradeStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS codex_grades (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        repo          TEXT NOT NULL,
        pr            INTEGER NOT NULL,
        sha           TEXT NOT NULL,
        qwen_verdict  TEXT NOT NULL,
        codex_verdict TEXT NOT NULL,
        agreement     TEXT NOT NULL,
        codex_url     TEXT NOT NULL,
        graded_at     TEXT NOT NULL,
        UNIQUE (repo, pr, sha)
      );
    `);
  }

  /** Stores one grade per head. Returns true when the row is new. Verdict words only: no review text. */
  record(row: { repo: string; pr: number; sha: string; qwen: string; codex: Verdict; codexUrl: string }): boolean {
    const a = agreement(row.qwen, row.codex);
    if (a === 'ungradeable') return false;
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO codex_grades (repo, pr, sha, qwen_verdict, codex_verdict, agreement, codex_url, graded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.repo, row.pr, row.sha, row.qwen, row.codex, a, row.codexUrl, new Date().toISOString());
    return res.changes > 0;
  }

  summary(): GradeSummary {
    const rows = this.db.query('SELECT qwen_verdict, codex_verdict, agreement, graded_at FROM codex_grades ORDER BY id').all() as {
      qwen_verdict: string;
      codex_verdict: string;
      agreement: string;
      graded_at: string;
    }[];
    return {
      graded: rows.length,
      agree: rows.filter((r) => r.agreement === 'agree').length,
      disagree: rows.filter((r) => r.agreement === 'disagree').length,
      missed: rows.filter((r) => r.qwen_verdict === 'clean' && r.codex_verdict !== 'no-blocking').length,
      since: rows[0]?.graded_at ?? null,
    };
  }

  close(): void {
    this.db.close();
  }
}
