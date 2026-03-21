/**
 * Remediation Task Database
 *
 * SQLite persistence for remediation tasks using bun:sqlite.
 * Tracks the lifecycle: pending → approved → executing → complete → failed
 * Auto-prunes entries older than 30 days.
 */

import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { logger } from '../utils/index.js';

export type RemediationState =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'complete'
  | 'failed'
  | 'rejected'
  | 'expired';

export interface RemediationTask {
  id: string;
  event_id: string;
  action: string;
  params: Record<string, string>;
  state: RemediationState;
  affected_service: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  result: string | null;
  discord_message_id: string | null;
}

interface RemediationRow {
  id: string;
  event_id: string;
  action: string;
  params: string;
  state: string;
  affected_service: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  result: string | null;
  discord_message_id: string | null;
}

const RETENTION_DAYS = 30;
const EXPIRY_MINUTES = 15;

export class RemediationDB {
  private db: Database;
  private pruneIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(dbPath = '/data/remediations.db') {
    this.db = new Database(dbPath, { create: true });
    this.initSchema();
    this.pruneIntervalId = setInterval(() => this.pruneOld(), 60 * 60 * 1000); // hourly
  }

  private initSchema(): void {
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remediations (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        action TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL DEFAULT 'pending',
        affected_service TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        result TEXT,
        discord_message_id TEXT
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_remediations_state
        ON remediations(state)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_remediations_service
        ON remediations(affected_service, state)
    `);

    logger.info('[RemediationDB] Schema initialized');
  }

  /**
   * Create a new remediation task.
   */
  create(params: {
    eventId: string;
    action: string;
    actionParams: Record<string, string>;
    affectedService: string;
    discordMessageId?: string;
  }): RemediationTask {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO remediations (id, event_id, action, params, state, affected_service, created_at, discord_message_id)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        id,
        params.eventId,
        params.action,
        JSON.stringify(params.actionParams),
        params.affectedService,
        now,
        params.discordMessageId ?? null,
      ],
    );

    return this.getById(id)!;
  }

  /**
   * Get a task by ID.
   */
  getById(id: string): RemediationTask | null {
    const row = this.db
      .query<RemediationRow, [string]>('SELECT * FROM remediations WHERE id = ?')
      .get(id);
    return row ? this.rowToTask(row) : null;
  }

  /**
   * Check if there's already an active remediation for a service.
   * (Max 1 active per service — safety control)
   */
  hasActiveForService(service: string): boolean {
    const row = this.db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) as count FROM remediations
         WHERE affected_service = ? AND state IN ('pending', 'approved', 'executing')`,
      )
      .get(service);
    return (row?.count ?? 0) > 0;
  }

  /**
   * Transition a task to a new state.
   */
  updateState(
    id: string,
    state: RemediationState,
    extra?: { resolvedBy?: string; result?: string },
  ): RemediationTask | null {
    const resolvedAt =
      state === 'complete' || state === 'failed' || state === 'rejected' || state === 'expired'
        ? new Date().toISOString()
        : null;

    this.db.run(
      `UPDATE remediations
       SET state = ?, resolved_at = COALESCE(?, resolved_at), resolved_by = COALESCE(?, resolved_by), result = COALESCE(?, result)
       WHERE id = ?`,
      [state, resolvedAt, extra?.resolvedBy ?? null, extra?.result ?? null, id],
    );

    return this.getById(id);
  }

  /**
   * Set the Discord message ID for a task (used to link button interactions).
   */
  setDiscordMessageId(id: string, messageId: string): void {
    this.db.run(
      'UPDATE remediations SET discord_message_id = ? WHERE id = ?',
      [messageId, id],
    );
  }

  /**
   * Find a task by Discord message ID.
   */
  findByDiscordMessageId(messageId: string): RemediationTask | null {
    const row = this.db
      .query<RemediationRow, [string]>(
        'SELECT * FROM remediations WHERE discord_message_id = ?',
      )
      .get(messageId);
    return row ? this.rowToTask(row) : null;
  }

  /**
   * Expire pending tasks older than EXPIRY_MINUTES.
   */
  expireStale(): number {
    const cutoff = new Date(Date.now() - EXPIRY_MINUTES * 60 * 1000).toISOString();
    const result = this.db.run(
      `UPDATE remediations SET state = 'expired', resolved_at = ?
       WHERE state = 'pending' AND created_at < ?`,
      [new Date().toISOString(), cutoff],
    );
    return result.changes;
  }

  /**
   * Delete entries older than RETENTION_DAYS.
   */
  pruneOld(): number {
    const cutoff = new Date(
      Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = this.db.run(
      'DELETE FROM remediations WHERE created_at < ?',
      [cutoff],
    );
    if (result.changes > 0) {
      logger.info(`[RemediationDB] Pruned ${result.changes} old tasks`);
    }
    return result.changes;
  }

  /**
   * Get recent tasks (for debugging / status).
   */
  getRecent(limit = 20): RemediationTask[] {
    const rows = this.db
      .query<RemediationRow, [number]>(
        'SELECT * FROM remediations ORDER BY created_at DESC LIMIT ?',
      )
      .all(limit);
    return rows.map((r: RemediationRow) => this.rowToTask(r));
  }

  private rowToTask(row: RemediationRow): RemediationTask {
    return {
      ...row,
      state: row.state as RemediationState,
      params: JSON.parse(row.params),
    };
  }

  destroy(): void {
    if (this.pruneIntervalId) {
      clearInterval(this.pruneIntervalId);
      this.pruneIntervalId = null;
    }
    this.db.close();
  }
}
