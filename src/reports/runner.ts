/**
 * Runs the reports on schedule and sends each as a DM (PET-701).
 *
 * ⚠ A FAILED REPORT IS A REPORT. A run that throws sends a DM that says which report failed
 * and why, then counts as run for the day, so it neither goes quiet nor repeats every
 * minute. A run whose DM did not send is not counted, and the next tick tries again until
 * the grace window ends.
 *
 * ⚠ THE STATE FILE HOLDS DATES, NOT REPORTS. It records the local date each report last
 * went out, so a restart inside the grace window neither loses nor repeats one.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { collectGithub, type GithubReads } from './collect.js';
import { buildAudit } from './audit.js';
import { buildMorning, COMMENT_ITEM_CAP, type CommentMap } from './morning.js';
import { buildSweep } from './sweep.js';
import { PlaneClient, type PlaneRead } from './plane.js';
import { dueReports, localTime } from './schedule.js';
import { REPORT_NAMES, type ReportName, type ReportSettings } from './settings.js';
import { isOpenItem, type Snapshot } from './snapshot.js';
import { readVault } from './vault.js';

export interface Sender {
  send(text: string): Promise<void>;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface LastRun {
  date: string;
  at: string;
  ok: boolean;
  incomplete: boolean;
  detail: string;
}

export interface ReportsStatus {
  enabled: ReportName[];
  last: Partial<Record<ReportName, LastRun>>;
}

type PlaneReader = Pick<PlaneClient, 'read' | 'lastComment'>;

export interface RunnerDeps {
  settings: ReportSettings;
  github: GithubReads;
  plane: PlaneReader | null;
  sender: Sender;
  log: Logger;
  now?: () => Date;
}

/** Splits at line breaks so no DM passes Discord's 2000-character limit. */
export function chunk(text: string, max = 1900): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    const piece = line.length > max ? `${line.slice(0, max - 1)}…` : line;
    if (cur && cur.length + 1 + piece.length > max) {
      out.push(cur);
      cur = piece;
    } else cur = cur ? `${cur}\n${piece}` : piece;
  }
  if (cur) out.push(cur);
  return out;
}

export class ReportRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private dates: Partial<Record<ReportName, string>> = {};
  private lastRuns: Partial<Record<ReportName, LastRun>> = {};
  private readonly now: () => Date;

  constructor(private readonly d: RunnerDeps) {
    this.now = d.now ?? (() => new Date());
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.d.settings.statePath)) return;
      const raw = JSON.parse(readFileSync(this.d.settings.statePath, 'utf8')) as { dates?: Partial<Record<ReportName, string>> };
      for (const n of REPORT_NAMES) if (typeof raw.dates?.[n] === 'string') this.dates[n] = raw.dates[n];
    } catch (err) {
      // An unreadable state file would resend today's reports once. That is the safe side.
      this.d.log.warn(`[Reports] state file unreadable, reports may repeat once: ${String(err)}`);
    }
  }

  private save(): void {
    try {
      writeFileSync(this.d.settings.statePath, JSON.stringify({ dates: this.dates }), { mode: 0o600 });
    } catch (err) {
      this.d.log.error(`[Reports] cannot save state, a restart may repeat a report: ${String(err)}`);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): ReportsStatus {
    return { enabled: [...this.d.settings.enabled], last: this.lastRuns };
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = dueReports(this.now(), this.dates, this.d.settings.enabled, this.d.settings.sweepWeekly);
      for (const name of due) await this.run(name, { markRun: true });
    } finally {
      this.busy = false;
    }
  }

  /** Builds and sends one report. Returns true when the DM went out. */
  async run(name: ReportName, opts: { markRun: boolean }): Promise<boolean> {
    const at = this.now();
    let text: string;
    let ok = true;
    let incomplete = false;
    let detail = 'sent';
    try {
      const built = await this.build(name, at);
      text = built;
      incomplete = built.includes('INCOMPLETE');
    } catch (err) {
      ok = false;
      const reason = err instanceof Error ? err.message : String(err);
      detail = reason.slice(0, 200);
      text = `⚠ **The ${name} report failed.** Nothing below was checked.\n${reason.slice(0, 500)}`;
      this.d.log.error(`[Reports] ${name} failed: ${reason}`);
    }
    try {
      for (const part of chunk(text)) await this.d.sender.send(part);
    } catch (err) {
      this.d.log.error(`[Reports] ${name} could not be sent: ${String(err)}`);
      this.lastRuns[name] = { date: localTime(at).date, at: at.toISOString(), ok: false, incomplete, detail: `DM failed: ${String(err).slice(0, 150)}` };
      return false;
    }
    this.lastRuns[name] = { date: localTime(at).date, at: at.toISOString(), ok, incomplete, detail };
    if (opts.markRun) {
      this.dates[name] = localTime(at).date;
      this.save();
    }
    this.d.log.info(`[Reports] ${name} sent (${ok ? (incomplete ? 'incomplete' : 'complete') : 'failed'})`);
    return true;
  }

  async build(name: ReportName, at: Date): Promise<string> {
    const s = this.d.settings;
    const plane: PlaneRead = this.d.plane ? await this.d.plane.read() : { ok: false, error: 'PLANE_API_KEY is empty on this host' };
    const repos = await collectGithub(this.d.github, s.org, s.repos, at);
    const snap: Snapshot = { at, repos, plane };
    if (!repos.some((r) => r.ok) && !plane.ok) throw new Error('neither GitHub nor Plane could be read');
    switch (name) {
      case 'morning': {
        const comments: CommentMap = new Map();
        if (plane.ok && this.d.plane) {
          const needs = plane.items.filter((i) => isOpenItem(i) && i.labels.includes('needs-pedro')).sort((a, b) => a.seq - b.seq);
          for (const i of needs.slice(0, COMMENT_ITEM_CAP)) {
            try {
              comments.set(i.seq, await this.d.plane.lastComment(i.id));
            } catch {
              comments.set(i.seq, 'error');
            }
          }
        }
        return buildMorning(snap, comments);
      }
      case 'audit':
        return buildAudit(snap, s.vaultPath ? readVault(s.vaultPath, at) : null);
      case 'sweep':
        return buildSweep(snap, s.staleDays);
    }
  }
}
