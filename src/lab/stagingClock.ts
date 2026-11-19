/**
 * The staging box's 24-hour clock. Staging stays up and shuts down at 24 hours of uptime, so Pedro
 * gets a warning at 3, 9 and 20 hours and the dashboard says when it will stop.
 *
 * The state is read from Proxmox (the guest's uptime), never guessed:
 *   - `up`: the guest runs; `uptimeSec` says for how long.
 *   - `limit`: the guest is stopped and its last reading was within LIMIT_SLACK_S of 24 hours,
 *     so the limit stopped it.
 *   - `stopped`: the guest is stopped and the last reading was earlier, or this process never saw it up.
 *   - `unknown`: Proxmox could not be read, or the guest is not in the answer.
 * A restart of this process forgets what it saw, so a stopped guest reads `stopped` until the next boot.
 */
export const LIMIT_S = 24 * 3600;
/** A reading this close to the limit, followed by a stop, counts as the limit's own shutdown. */
export const LIMIT_SLACK_S = 10 * 60;
export const THRESHOLDS_H = [3, 9, 20] as const;

export type StagingState =
  | { state: 'up'; uptimeSec: number; shutsDownInSec: number; checkedAt: string }
  | { state: 'limit' | 'stopped' | 'unknown'; checkedAt: string; detail: string };

export interface GuestReading { status: string; uptimeSec: number }

export class StagingClock {
  private lastUptime: number | null = null;
  private alerted = new Set<number>();
  private primed = false;
  /** Why the guest stopped, kept across stopped readings until a running one is seen. */
  private stopKind: 'limit' | 'stopped' | null = null;

  /**
   * Fold one reading into the clock. `reading` is null when Proxmox did not answer or the guest is
   * absent. Returns the state and the alerts to send now, each threshold once per boot.
   */
  observe(reading: GuestReading | null, now: Date, why = 'Proxmox did not return the staging guest'): { state: StagingState; alerts: number[] } {
    const checkedAt = now.toISOString();
    if (!reading) return { state: { state: 'unknown', checkedAt, detail: why }, alerts: [] };
    // A status Proxmox did not give is unknown. It changes nothing about the boot we are tracking.
    if (reading.status !== 'running' && reading.status !== 'stopped') {
      return { state: { state: 'unknown', checkedAt, detail: `Proxmox reported the guest status as ${reading.status}` }, alerts: [] };
    }
    if (reading.status === 'stopped') {
      if (this.stopKind === null) this.stopKind = this.lastUptime !== null && this.lastUptime >= LIMIT_S - LIMIT_SLACK_S ? 'limit' : 'stopped';
      this.lastUptime = null;
      this.alerted.clear();
      this.primed = false;
      return this.stopKind === 'limit'
        ? { state: { state: 'limit', checkedAt, detail: 'stopped by the 24-hour limit' }, alerts: [] }
        : { state: { state: 'stopped', checkedAt, detail: 'the guest is stopped' }, alerts: [] };
    }
    this.stopKind = null;
    // A shorter uptime than the last reading means a new boot: its alerts start over.
    if (this.lastUptime !== null && reading.uptimeSec < this.lastUptime) this.alerted.clear();
    this.lastUptime = reading.uptimeSec;
    const crossed = THRESHOLDS_H.filter((h) => reading.uptimeSec >= h * 3600 && !this.alerted.has(h));
    for (const h of crossed) this.alerted.add(h);
    // First reading after this process starts: mark crossed thresholds as sent without alerting,
    // because a restart cannot tell whether they went out. A missed alert beats a repeated one.
    const alerts = this.primed ? crossed : [];
    this.primed = true;
    return { state: { state: 'up', uptimeSec: reading.uptimeSec, shutsDownInSec: Math.max(0, LIMIT_S - reading.uptimeSec), checkedAt }, alerts };
  }
}

/** `hours` is the threshold that crossed; the countdown comes from the uptime read, which can be later than the threshold. */
export function alertText(hours: number, uptimeSec: number): string {
  const up = Math.floor(uptimeSec / 3600);
  const left = Math.max(0, Math.ceil((LIMIT_S - uptimeSec) / 3600));
  return `Staging passed ${hours} hours of uptime (${up}h read from Proxmox). It shuts down at 24 hours, in about ${left} ${left === 1 ? 'hour' : 'hours'}. A new push starts a fresh 24 hours.`;
}
