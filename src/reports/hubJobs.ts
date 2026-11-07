/**
 * Hub-only reports (PET-871 onward): collectors that save a dashboard record and send no DM.
 * Each job runs once per local date, from its hour until midnight, so a restart or a failed
 * read tries again on the next tick. Plane and the lab cost no Claude quota, so school days do
 * not skip them.
 */
import { localTime } from './schedule.js';
import type { HubRecord, ReportHub } from './hub.js';

export interface HubJob {
  kind: string;
  /** Local hour (Eastern) from which the job is due. */
  hour: number;
  /** Null stores nothing and counts as a failed try. */
  collect(at: Date): Promise<HubRecord | null>;
}

interface Log {
  info(m: string): void;
  warn(m: string): void;
}

export class HubJobs {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private done = new Map<string, string>();
  readonly last = new Map<string, { date: string; ok: boolean; detail: string }>();

  constructor(
    private readonly hub: ReportHub,
    private readonly jobs: HubJob[],
    private readonly log: Log,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 5 * 60_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const at = this.now();
      const t = localTime(at);
      for (const job of this.jobs) {
        // A restart the same day must not rebuild a record the store already holds.
        if (this.done.get(job.kind) === t.date || t.minutes < job.hour * 60) continue;
        if (this.hub.has(job.kind, t.date)) {
          this.done.set(job.kind, t.date);
          continue;
        }
        try {
          const rec = await job.collect(at);
          if (!rec) throw new Error('the collector returned no record');
          this.hub.save(job.kind, rec);
          this.done.set(job.kind, t.date);
          this.last.set(job.kind, { date: t.date, ok: true, detail: 'stored' });
          this.log.info(`[Hub] ${job.kind} stored for ${t.date}`);
        } catch (err) {
          const detail = (err instanceof Error ? err.message : String(err)).slice(0, 200);
          this.last.set(job.kind, { date: t.date, ok: false, detail });
          this.log.warn(`[Hub] ${job.kind} failed, will retry: ${detail}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
