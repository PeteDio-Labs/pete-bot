/**
 * When each report is due (PET-701). Times are Eastern, as the Claude routines they replace.
 *
 * ⚠ A MISSED MINUTE MUST NOT LOSE A REPORT. A deploy at 07:53 would skip a report due at
 * 07:52 if the schedule matched the minute exactly. A report is due from its time until
 * GRACE_MINUTES later, once per local date, so a restart inside that window still sends it
 * and a second tick never sends it twice.
 */
import type { ReportName } from './settings.js';

export const TIME_ZONE = 'America/New_York';
export const GRACE_MINUTES = 180;

interface Slot {
  /** Local weekdays, 0 = Sunday. */
  days: number[];
  hour: number;
  minute: number;
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

export function slotFor(name: ReportName, sweepWeekly: boolean): Slot {
  switch (name) {
    case 'morning':
      return { days: WEEKDAYS, hour: 7, minute: 52 };
    case 'audit':
      return { days: [1], hour: 8, minute: 44 };
    case 'sweep':
      return { days: sweepWeekly ? [1] : EVERY_DAY, hour: 18, minute: 47 };
  }
}

export interface LocalTime {
  /** YYYY-MM-DD in Eastern. */
  date: string;
  weekday: number;
  minutes: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localTime(at: Date): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WEEKDAY_INDEX[get('weekday')] ?? -1,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** The reports due now: today's slot has started, its grace has not ended, and it has not run today. */
export function dueReports(
  at: Date,
  last: Partial<Record<ReportName, string>>,
  enabled: ReadonlySet<ReportName>,
  sweepWeekly: boolean,
): ReportName[] {
  const t = localTime(at);
  const out: ReportName[] = [];
  for (const name of enabled) {
    const slot = slotFor(name, sweepWeekly);
    if (!slot.days.includes(t.weekday)) continue;
    const start = slot.hour * 60 + slot.minute;
    if (t.minutes < start || t.minutes >= start + GRACE_MINUTES) continue;
    if (last[name] === t.date) continue;
    out.push(name);
  }
  return out;
}
