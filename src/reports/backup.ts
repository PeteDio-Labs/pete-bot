/**
 * Off-host copy of the reports database (PET-868): once a day the bot writes a consistent
 * snapshot of `reports.sqlite` to a MinIO bucket, which keeps object versions.
 *
 * ⚠ A BACKUP THAT NEVER RAN MUST NOT LOOK LIKE ONE THAT DID. `state()` says "off" when no
 * bucket is set, "never" when one is set and no copy has landed, "failing" after a failed
 * copy, and "ok" only with the time of the last copy and its size. /health carries it.
 */
import { S3Client } from 'bun';
import type { Database } from 'bun:sqlite';
import { snapshot } from './db.js';
import type { Logger } from './runner.js';

export interface BackupSettings {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export type BackupConfig = { state: 'off' } | { state: 'misconfigured'; reason: string } | { state: 'ready'; settings: BackupSettings };

export interface BackupEnv {
  REPORT_BACKUP_ENDPOINT?: string;
  REPORT_BACKUP_BUCKET?: string;
  REPORT_BACKUP_ACCESS_KEY?: string;
  REPORT_BACKUP_SECRET_KEY?: string;
}

/** All four settings or none: a half-set backup is reported, never half-run. */
export function loadBackupConfig(env: BackupEnv): BackupConfig {
  const v = (x: string | undefined): string => (x ?? '').trim();
  const names = ['REPORT_BACKUP_ENDPOINT', 'REPORT_BACKUP_BUCKET', 'REPORT_BACKUP_ACCESS_KEY', 'REPORT_BACKUP_SECRET_KEY'] as const;
  const set = names.filter((n) => v(env[n]));
  if (set.length === 0) return { state: 'off' };
  if (set.length < names.length) return { state: 'misconfigured', reason: `the backup needs all of ${names.join(', ')}; missing ${names.filter((n) => !v(env[n])).join(', ')}` };
  const endpoint = v(env.REPORT_BACKUP_ENDPOINT).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(endpoint)) return { state: 'misconfigured', reason: 'REPORT_BACKUP_ENDPOINT must start with http:// or https://' };
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v(env.REPORT_BACKUP_BUCKET))) return { state: 'misconfigured', reason: 'REPORT_BACKUP_BUCKET is not a bucket name' };
  return { state: 'ready', settings: { endpoint, bucket: v(env.REPORT_BACKUP_BUCKET), accessKey: v(env.REPORT_BACKUP_ACCESS_KEY), secretKey: v(env.REPORT_BACKUP_SECRET_KEY) } };
}

export interface BackupTarget {
  put(key: string, body: Uint8Array): Promise<void>;
}

/** MinIO takes path-style addressing, which Bun's client uses unless virtual hosting is asked for. */
export function s3Target(s: BackupSettings): BackupTarget {
  const client = new S3Client({ endpoint: s.endpoint, bucket: s.bucket, accessKeyId: s.accessKey, secretAccessKey: s.secretKey, region: 'us-east-1' });
  return {
    async put(key, body) {
      await client.write(key, body, { type: 'application/vnd.sqlite3' });
    },
  };
}

export const BACKUP_KEY = 'reports.sqlite';
const DAY_MS = 24 * 3600_000;

export type BackupState = { state: 'never' } | { state: 'ok'; at: string; bytes: number } | { state: 'failing'; at: string; detail: string; lastOk: string | null };

export class ReportBackup {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private lastFail: { at: string; detail: string } | null = null;

  constructor(
    private readonly db: Database,
    private readonly target: BackupTarget,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private meta(key: string): string | null {
    return (this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | null)?.value ?? null;
  }
  private setMeta(key: string, value: string): void {
    this.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  state(): BackupState {
    const ok = this.meta('backup_ok_at');
    if (this.lastFail && (!ok || this.lastFail.at > ok)) return { state: 'failing', at: this.lastFail.at, detail: this.lastFail.detail, lastOk: ok };
    if (!ok) return { state: 'never' };
    return { state: 'ok', at: ok, bytes: Number(this.meta('backup_bytes') ?? 0) };
  }

  due(): boolean {
    const ok = this.meta('backup_ok_at');
    return !ok || this.now().getTime() - Date.parse(ok) >= DAY_MS;
  }

  /** Writes one snapshot. Returns whether it landed; a failure is logged and kept for /health. */
  async run(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    const at = this.now().toISOString();
    try {
      const bytes = snapshot(this.db);
      await this.target.put(BACKUP_KEY, bytes);
      this.setMeta('backup_ok_at', at);
      this.setMeta('backup_bytes', String(bytes.byteLength));
      this.lastFail = null;
      this.log.info(`[Backup] reports.sqlite copied, ${bytes.byteLength} bytes`);
      return true;
    } catch (err) {
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      this.lastFail = { at, detail };
      this.log.error(`[Backup] the copy failed: ${detail}`);
      return false;
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    if (this.timer) return;
    const tick = (): void => {
      if (this.due()) void this.run();
    };
    this.timer = setInterval(tick, 15 * 60_000);
    tick();
  }
}
