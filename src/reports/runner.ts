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
import { buildCveReport, FILE_CAP, snapshotFresh, isFileable, NO_FILING, readSnapshot, runCveCheck, upgradeHint, type CveRun, type Filing, type Finding } from './cve.js';
import { PlaneClient, PlaneHttpError, type CycleRead, type PlaneRead } from './plane.js';
import { dueReports, localTime } from './schedule.js';
import { REPORT_NAMES, type ReportName, type ReportSettings } from './settings.js';
import { isOpenItem, type Snapshot } from './snapshot.js';
import { readVault } from './vault.js';

function cveItemHtml(f: Finding): string {
  const li = (x: string): string => `<li>${x.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)}</li>`;
  return [
    `<p>Filed by the daily CVE check (PET-770). ${f.kev ? 'CISA lists at least one of these as exploited in the wild.' : `Highest severity: ${f.severity}.`}</p>`,
    `<ul>${[`Package: ${f.package} ${f.installed} (${f.ecosystem})`, `Hosts: ${f.hosts.join(', ')}`, `Fixed in: ${f.fixed}`, `Advisories: ${f.advisories.slice(0, 10).join(', ')}`, `Suggested: ${upgradeHint(f).replace(/`/g, '')}`].map(li).join('')}</ul>`,
    '<p>Apply the upgrade through the node-upgrade role or the iac pin, then the next daily check confirms it.</p>',
  ].join('');
}

const CVE_RETRY_MINUTES = 30;
const CVE_ATTEMPTS = 3;

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

type PlaneReader = Pick<PlaneClient, 'read' | 'lastComment' | 'cycles' | 'createItem'>;

export interface RunnerDeps {
  settings: ReportSettings;
  github: GithubReads;
  plane: PlaneReader | null;
  sender: Sender;
  log: Logger;
  now?: () => Date;
  /** Test seam for the OSV and CISA feeds. */
  feedFetch?: typeof fetch;
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
  /** Failed attempts today and the earliest next try, for the reports that retry (cve). */
  private retries: { date: string; attempts: number; notBefore: number } = { date: '', attempts: 0, notBefore: 0 };
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
      const due = dueReports(this.now(), this.dates, this.d.settings.enabled).filter(
        (n) => n !== 'cve' || this.now().getTime() >= this.retries.notBefore || this.retries.date !== localTime(this.now()).date,
      );
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
    // A transient feed failure must not spend the day (PET-770). The cve report retries every
    // CVE_RETRY_MINUTES, up to CVE_ATTEMPTS tries, and each failed try still sends its failure DM.
    if (name === 'cve' && !ok && opts.markRun) {
      const date = localTime(at).date;
      const attempts = (this.retries.date === date ? this.retries.attempts : 0) + 1;
      this.retries = { date, attempts, notBefore: at.getTime() + CVE_RETRY_MINUTES * 60_000 };
      if (attempts < CVE_ATTEMPTS) {
        this.d.log.warn(`[Reports] cve failed (attempt ${attempts} of ${CVE_ATTEMPTS}), retrying in ${CVE_RETRY_MINUTES} minutes`);
        return true;
      }
    }
    if (opts.markRun) {
      this.dates[name] = localTime(at).date;
      this.save();
    }
    this.d.log.info(`[Reports] ${name} sent (${ok ? (incomplete ? 'incomplete' : 'complete') : 'failed'})`);
    return true;
  }

  /**
   * One PET item per exploited or high-severity finding with a fix. Every candidate is tried
   * until FILE_CAP items are created, so findings already filed on an earlier day (Plane's 409)
   * never crowd out a new one.
   */
  private async fileFindings(run: CveRun): Promise<Filing> {
    const s = this.d.settings;
    if (!s.cveFileItems) return NO_FILING;
    const out: Filing = { enabled: true, created: [], existing: 0, overCap: 0, gaps: [] };
    if (!this.d.plane) return { ...out, gaps: ['PET items were not filed because PLANE_API_KEY is empty on this host'] };
    // Filed items are deduplicated forever, so a finding filed on degraded data keeps its wrong priority.
    if (run.kevSize === null) return { ...out, gaps: ['PET items were not filed because the CISA KEV catalog was not read'] };
    if (!snapshotFresh(run.snapshotAgeHours)) return { ...out, gaps: ['PET items were not filed because the inventory snapshot is stale or dated in the future'] };
    // Filed items are deduplicated forever, so degraded data must not file anything (a 409 would hide the later, fuller finding).
    if (run.advisoryGaps.length > 0 || run.truncated > 0) {
      const why = [...run.advisoryGaps.slice(0, 2), ...(run.truncated > 0 ? [`${run.truncated} OSV answers were paged`] : [])].join('; ');
      return { ...out, gaps: [`PET items were not filed because the findings are unreliable (${why})`] };
    }
    const want = run.findings.filter(isFileable);
    for (const [i, f] of want.entries()) {
      if (out.created.length >= FILE_CAP) {
        out.overCap = want.length - i;
        break;
      }
      try {
        const r = await this.d.plane.createItem({
          name: `Update ${f.package} on ${f.hosts.slice(0, 3).join(', ')} (${f.kev ? 'exploited, ' : ''}${f.cves[0] ?? f.advisories[0]})`,
          descriptionHtml: cveItemHtml(f),
          priority: f.kev || f.severity === 'CRITICAL' ? 'high' : 'medium',
          labels: ['security', 'lan'],
          externalSource: 'pete-bot-cve',
          externalId: f.key,
        });
        if (r.status === 'created') out.created.push(`PET-${r.seq ?? '?'}`);
        else out.existing++;
      } catch (err) {
        // A 4xx belongs to this finding (a bad field), so the next one may still file. Anything
        // else (a 5xx, a timeout, a missing label) fails every item the same way, so stop.
        // 400 and 422 name this finding's fields. 401, 403, 404 and 429 hit every item the same way.
        const own = err instanceof PlaneHttpError && (err.status === 400 || err.status === 422);
        out.gaps.push(`could not file ${f.package}: ${String(err).slice(0, 120)}${own ? '' : `; filing stopped, ${want.length - i - 1} candidates not tried`}`);
        if (!own) break;
      }
    }
    return out;
  }

  async build(name: ReportName, at: Date): Promise<string> {
    const s = this.d.settings;
    if (name === 'cve') {
      const run = await runCveCheck(readSnapshot(s.cveSnapshotPath), at, this.d.feedFetch ?? fetch);
      return buildCveReport(run, localTime(at).date, await this.fileFindings(run));
    }
    const plane: PlaneRead = this.d.plane ? await this.d.plane.read() : { ok: false, error: 'PLANE_API_KEY is empty on this host' };
    const repos = await collectGithub(this.d.github, s.org, s.repos, at);
    if (!repos.some((r) => r.ok) && !plane.ok) throw new Error('neither GitHub nor Plane could be read');
    // Only the morning queue shows the cycle. A failed read becomes a gap in that report, not a throw.
    const cycles: CycleRead | undefined =
      name === 'morning' && plane.ok && this.d.plane ? await this.d.plane.cycles(localTime(at).date) : undefined;
    const snap: Snapshot = { at, repos, plane, cycles };
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
