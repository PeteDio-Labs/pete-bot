/**
 * "Is this maintenance?" for a DOWN heartbeat (PET-492).
 *
 * pve03's vzdump job (02:45 America/New_York, mode stop) restarts every guest on the node.
 * authentik, vault and plane take longer than Kuma's two 20 s checks to come back, so each
 * night they alerted. The question sits behind an interface so Laya can answer it later
 * (PET-491). The first decider is a clock.
 *
 * ALERT_MAINTENANCE_WINDOWS holds comma-separated `<IANA zone> <HH:MM> <minutes>` entries.
 * An empty value turns the feature off. A malformed value throws, so the deploy's health
 * check fails instead of the feature silently turning off.
 */

export interface MaintenanceWindow {
  zone: string;
  /** Minutes after local midnight. */
  startMinute: number;
  minutes: number;
  label: string;
}

export interface MaintenanceDecider {
  /** The window label when `at` is inside one, otherwise null. */
  isMaintenance(at: Date): string | null;
}

export function parseWindows(raw: string): MaintenanceWindow[] {
  const windows: MaintenanceWindow[] = [];
  for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
    const match = /^(\S+)\s+(\d{2}):(\d{2})\s+(\d+)$/.exec(entry);
    if (!match) throw new Error(`ALERT_MAINTENANCE_WINDOWS: cannot parse "${entry}", expected "<IANA zone> <HH:MM> <minutes>"`);
    const [, zone, hh, mm, len] = match as unknown as [string, string, string, string, string];
    const hour = Number(hh);
    const minute = Number(mm);
    const minutes = Number(len);
    if (hour > 23 || minute > 59) throw new Error(`ALERT_MAINTENANCE_WINDOWS: "${entry}" has a start time outside 00:00 to 23:59`);
    if (minutes < 1 || minutes > 24 * 60) throw new Error(`ALERT_MAINTENANCE_WINDOWS: "${entry}" has a length outside 1 to 1440 minutes`);
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
    } catch {
      throw new Error(`ALERT_MAINTENANCE_WINDOWS: "${zone}" is not an IANA time zone`);
    }
    windows.push({ zone, startMinute: hour * 60 + minute, minutes, label: `${zone} ${hh}:${mm} for ${minutes} min` });
  }
  return windows;
}

function minuteOfDay(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  return hour * 60 + minute;
}

/** The backup schedule: a window is open from its start, for its length, wrapping past midnight. */
export function scheduleDecider(windows: MaintenanceWindow[]): MaintenanceDecider {
  return {
    isMaintenance(at: Date): string | null {
      for (const w of windows) {
        const elapsed = (minuteOfDay(at, w.zone) - w.startMinute + 24 * 60) % (24 * 60);
        if (elapsed < w.minutes) return w.label;
      }
      return null;
    },
  };
}
