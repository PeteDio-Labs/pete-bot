/**
 * The reports hub (PET-868): one folder per report kind under the dashboard's directory, one
 * JSON file per record. The weekly PR report keeps its flat files; every other kind (the daily
 * CVE check, Plane cycle progress, ...) saves through here, and the dashboard lists whatever
 * is stored.
 *
 * ⚠ A record says what it examined. The store keeps the record a kind wrote and adds nothing
 * to it, so a kind that stored "0 findings" must also have stored what it read.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  private readonly root: string;
  constructor(dir: string) {
    this.root = join(dir, 'reports');
    mkdirSync(this.root, { recursive: true });
  }

  private kindDir(kind: string): string {
    if (!KIND_RE.test(kind)) throw new Error(`bad report kind "${kind}"`);
    return join(this.root, kind);
  }

  save(kind: string, rec: HubRecord): void {
    if (!ID_RE.test(rec.id)) throw new Error(`bad record id "${rec.id}"`);
    const dir = this.kindDir(kind);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${rec.id}.json`);
    // Write then rename, so the dashboard never reads half a file.
    writeFileSync(`${path}.tmp`, JSON.stringify(rec), { mode: 0o640 });
    renameSync(`${path}.tmp`, path);
  }

  private ids(kind: string): string[] {
    let names: string[];
    try {
      names = readdirSync(this.kindDir(kind));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return names
      .map((f) => /^(.+)\.json$/.exec(f)?.[1])
      .filter((id): id is string => !!id && ID_RE.test(id))
      .sort()
      .reverse();
  }

  has(kind: string, id: string): boolean {
    return this.ids(kind).includes(id);
  }

  /** The kinds that have a folder, with how many records each holds. */
  kinds(): KindInfo[] {
    return readdirSync(this.root)
      .filter((k) => KIND_RE.test(k))
      .sort()
      .map((kind) => {
        const ids = this.ids(kind);
        return { kind, count: ids.length, newest: ids[0] ?? null };
      })
      .filter((k) => k.count > 0);
  }

  /** The newest records of a kind, newest first. A file that cannot be read is named, not skipped. */
  list(kind: string): { records: HubRecord[]; unreadable: string[] } {
    const records: HubRecord[] = [];
    const unreadable: string[] = [];
    for (const id of this.ids(kind).slice(0, FEED_LIMIT)) {
      try {
        records.push(JSON.parse(readFileSync(join(this.kindDir(kind), `${id}.json`), 'utf8')) as HubRecord);
      } catch {
        unreadable.push(id);
      }
    }
    return { records, unreadable };
  }
}
