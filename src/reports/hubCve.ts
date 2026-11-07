/**
 * The daily CVE check as a hub record (PET-868). One record per local day; a second run the same
 * day replaces the first. The record says what the run examined next to what it found, so
 * "0 findings" after reading 40 hosts and "0 findings" after reading none cannot look alike.
 */
import { FUTURE_SLACK_HOURS, STALE_SNAPSHOT_HOURS, isActionable, type CveRun } from './cve.js';
import type { HubRecord } from './hub.js';

export const CVE_KIND = 'cve';
const TOP = 15;
const SEVERITIES = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW', 'unrated'] as const;

/** The gaps the daily DM lists, minus filing's: anything that leaves something unexamined. */
export function cveGaps(run: CveRun): string[] {
  const gaps = [...run.advisoryGaps, ...run.inventoryGaps];
  for (const h of run.hostsUnread) gaps.push(`${h.name} was not scanned: ${h.error}`);
  if (run.kevError) gaps.push(`${run.kevError}, so nothing is marked as exploited`);
  if (run.truncated) gaps.push(`${run.truncated} OSV answers were paged and only the first page was read`);
  if (run.snapshotAgeHours < -FUTURE_SLACK_HOURS) gaps.push(`the inventory is dated ${Math.round(-run.snapshotAgeHours)} hours in the future, so its age cannot be trusted`);
  if (run.snapshotAgeHours > STALE_SNAPSHOT_HOURS) gaps.push(`the inventory is ${Math.round(run.snapshotAgeHours)} hours old, so installed versions may have changed`);
  return gaps.map((g) => g.slice(0, 200));
}

/** A second run the same day replaces the first unless that would trade a complete record for a gapped one. */
export function shouldReplace(existing: HubRecord | null, next: HubRecord): boolean {
  return !(existing && existing.complete === true && next.complete !== true);
}

export function cveRecord(run: CveRun, date: string, at: Date): HubRecord {
  const bySeverity: Record<string, number> = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of run.findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  const actionable = run.findings.filter(isActionable);
  const gaps = cveGaps(run);
  return {
    id: date,
    generatedAt: at.toISOString(),
    complete: gaps.length === 0,
    examined: {
      hostsRead: run.hostsRead,
      hostsUnread: run.hostsUnread.map((h) => h.name),
      queries: run.queries,
      advisories: run.uniqueAdvisories,
      advisoriesFetched: run.advisoriesFetched,
      kevEntries: run.kevSize,
      snapshotAgeHours: Math.round(run.snapshotAgeHours * 10) / 10,
      images: run.imageCount,
    },
    gaps,
    findings: run.findings.length,
    actionable: actionable.length,
    exploited: run.findings.filter((f) => f.kev || f.kevUnfixed).length,
    bySeverity,
    top: actionable.slice(0, TOP).map((f) => ({
      package: f.package,
      installed: f.installed,
      fixed: f.fixed,
      severity: f.severity,
      kev: f.kev || f.kevUnfixed,
      hosts: f.hosts.slice(0, 4),
      cve: f.cves[0] ?? f.advisories[0] ?? null,
    })),
  };
}
