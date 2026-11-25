/**
 * What the dashboard remembers between reads: alerts per day, uptime cells per service and the triage counts
 * (PET-940 follow-up). The live sections carry no history of their own, so a sampler records them here and the
 * feed's `history` and `triage` sections read from this file.
 *
 * ⚠ A SECTION SAYS WHAT IT OBSERVED. `since` is the first sample, so a count never claims days the ledger did not
 * watch. An unreadable file is reported as absent (`null`), never as a clean zero, and a write that fails is logged
 * by the caller and leaves the last good file in place.
 *
 * Alerts are keyed by monitor and start time, so sampling the same open incident twice counts it once.
 * Triage is not wired into the alert path, so a card exists only when a held DOWN carried a note: every other
 * incident is counted as sent plain.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AlertBatch } from '../server/alertStore.js';
import type { HubRecord, ReportHub } from './hub.js';
import { CVE_KIND } from './hubCve.js';

export type AlertClass = 'act' | 'unreadable';
export interface UptimeCell { at: string; state: 'ok' | 'down' | 'unknown'; detail?: string }

interface LedgerFile {
  since: string;
  /** day -> incident key -> class */
  alerts: Record<string, Record<string, AlertClass>>;
  uptime: Record<string, UptimeCell[]>;
}

const DAYS = 30;
const CELLS = 96;
/** One uptime cell per service per half hour, however often the sampler runs. */
const CELL_GAP_MS = 30 * 60_000;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface ServiceReading {
  name: string;
  lab: { ok: boolean; checkedAt: string; detail: string } | null;
}

export class Ledger {
  private data: LedgerFile | null = null;
  private readonly path: string;

  constructor(dir: string, private readonly onError: (msg: string) => void = () => {}) {
    this.path = join(dir, 'dashboard-ledger.json');
  }

  private load(now: Date): LedgerFile {
    if (this.data) return this.data;
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, 'utf8')) as LedgerFile;
        if (typeof raw.since === 'string' && raw.alerts && raw.uptime) return (this.data = raw);
        throw new Error('the file has an unexpected shape');
      } catch (err) {
        // Keep the unreadable file for a person to look at, and start a new one that says when it began.
        this.onError(`the dashboard ledger could not be read (${(err as Error).message}); a new one starts now`);
        try { renameSync(this.path, `${this.path}.unreadable-${now.getTime()}`); } catch { /* nothing more to do */ }
      }
    }
    return (this.data = { since: now.toISOString(), alerts: {}, uptime: {} });
  }

  /** Records the open and recent incidents and each service's reading. Returns how many incidents and cells were new. */
  observe(now: Date, batches: AlertBatch[], services: ServiceReading[]): { incidents: number; cells: number } {
    const d = this.load(now);
    let incidents = 0;
    let cells = 0;
    for (const b of batches) {
      for (const [monitor, st] of Object.entries(b.monitors)) {
        const day = new Date(st.since).toISOString().slice(0, 10);
        const key = `${monitor}@${st.since}`;
        const bucket = (d.alerts[day] ??= {});
        const cls: AlertClass = st.note ? 'act' : 'unreadable';
        if (bucket[key] === undefined) incidents++;
        // A note can arrive after the first sample, so a card upgrades the class and never downgrades it.
        if (bucket[key] !== 'act') bucket[key] = cls;
      }
    }
    for (const s of services) {
      if (!NAME.test(s.name)) continue;
      const list = (d.uptime[s.name] ??= []);
      const last = list.at(-1);
      if (last && now.getTime() - Date.parse(last.at) < CELL_GAP_MS) continue;
      const state: UptimeCell['state'] = s.lab ? (s.lab.ok ? 'ok' : 'down') : 'unknown';
      list.push({ at: now.toISOString(), state, ...(s.lab?.detail && state !== 'ok' ? { detail: s.lab.detail.slice(0, 80) } : {}) });
      if (list.length > CELLS) list.splice(0, list.length - CELLS);
      cells++;
    }
    const keep = Object.keys(d.alerts).sort().slice(-DAYS);
    for (const day of Object.keys(d.alerts)) if (!keep.includes(day)) delete d.alerts[day];
    if (incidents || cells) this.save();
    return { incidents, cells };
  }

  private save(): void {
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      this.onError(`the dashboard ledger was not saved: ${(err as Error).message}`);
    }
  }

  /** The feed's `history` section, or null when the ledger has observed nothing yet. CVE days come from the hub's daily records. */
  history(now: Date, hub: ReportHub | null): Record<string, unknown> | null {
    const d = this.load(now);
    const days = Object.keys(d.alerts).sort();
    const alerts = days.map((day) => {
      const v = Object.values(d.alerts[day]!);
      return { day, act: v.filter((c) => c === 'act').length, noAction: 0, unreadable: v.filter((c) => c === 'unreadable').length };
    });
    const cve = hub ? cveDays(hub) : [];
    if (alerts.length === 0 && cve.length === 0 && Object.keys(d.uptime).length === 0) return null;
    // No failover drill has been recorded anywhere, so the list is empty and the chart says none has run.
    return { alerts, cve, drills: [], uptime: d.uptime };
  }

  /** Counts of the incidents the ledger saw since it began. */
  triage(now: Date): Record<string, unknown> {
    const d = this.load(now);
    const all = Object.values(d.alerts).flatMap((b) => Object.values(b));
    const cards = all.filter((c) => c === 'act').length;
    return { read: all.length, cards, plain: all.length - cards, failures: 0, since: d.since.slice(0, 10) };
  }
}

function cveDays(hub: ReportHub): { day: string; critical: number; high: number; medium: number; low: number }[] {
  const { records } = hub.list(CVE_KIND);
  const out: { day: string; critical: number; high: number; medium: number; low: number }[] = [];
  for (const r of records as HubRecord[]) {
    const s = r.bySeverity;
    if (typeof s !== 'object' || s === null) continue;
    const c = s as Record<string, unknown>;
    const n = (k: string): number => (typeof c[k] === 'number' && Number.isFinite(c[k] as number) ? (c[k] as number) : 0);
    // The producer names severities in capitals, and calls medium MODERATE. Unrated findings have no column.
    out.push({ day: r.id.slice(0, 10), critical: n('CRITICAL'), high: n('HIGH'), medium: n('MODERATE'), low: n('LOW') });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day)).slice(-DAYS);
}
