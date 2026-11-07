/**
 * The reports database (PET-868): one SQLite file holds every weekly record and every hub
 * record, so a backup is one consistent copy instead of a folder of files.
 *
 * ⚠ THE FILES ARE IMPORTED ONCE. The first open of a store that still holds the earlier JSON
 * files copies each into a table, bad ones included so they stay named as unreadable, and
 * records that it did so in `user_version`. The files stay on disk, untouched, as a second
 * copy. After that the database is the only store: a file added later is not read.
 */
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DB_FILE = 'reports.sqlite';
const opened = new Map<string, Database>();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS weeks (week TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hub (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (kind, id));
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Opens (once per directory) the database in `dir`, creating it and importing the JSON files. */
export function openReportDb(dir: string): Database {
  const path = join(dir, DB_FILE);
  const known = opened.get(path);
  if (known) return known;
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version < 1) {
    importJson(db, dir);
    db.exec('PRAGMA user_version = 1');
  }
  opened.set(path, db);
  return db;
}

function importJson(db: Database, dir: string): void {
  const putWeek = db.prepare('INSERT OR IGNORE INTO weeks (week, body) VALUES (?, ?)');
  const putHub = db.prepare('INSERT OR IGNORE INTO hub (kind, id, body) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const f of readdirSync(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (m) putWeek.run(m[1]!, readFileSync(join(dir, f), 'utf8'));
    }
    const root = join(dir, 'reports');
    if (!existsSync(root)) return;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^[a-z][a-z0-9-]{0,31}$/.test(e.name)) continue;
      for (const f of readdirSync(join(root, e.name))) {
        const m = /^(\d{4}-\d{2}-\d{2}(?:-[a-z0-9]{1,16})?)\.json$/.exec(f);
        if (m) putHub.run(e.name, m[1]!, readFileSync(join(root, e.name, f), 'utf8'));
      }
    }
  })();
}

/**
 * A consistent copy of the whole database, safe to take while the bot writes. The live file is
 * in WAL mode, and a copy that says so cannot open without a WAL file beside it, so the copy
 * is marked as a rollback-journal database (bytes 18 and 19 of the header) and opens alone.
 */
export function snapshot(db: Database): Uint8Array {
  const bytes = db.serialize();
  if (bytes.byteLength > 19) {
    bytes[18] = 1;
    bytes[19] = 1;
  }
  return bytes;
}
