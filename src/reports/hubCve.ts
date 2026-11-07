/**
 * The daily CVE check as a hub record (PET-868). One record per local day; a second run the same
 * day replaces the first. The record says what the run examined next to what it found, so
 * "0 findings" after reading 40 hosts and "0 findings" after reading none cannot look alike.
 */
import { isActionable, type CveRun } from './cve.js';
import type { HubRecord } from './hub.js';

export const CVE_KIND = 'cve';
const TOP = 15;
const SEVERITIES = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW', 'unrated'] as const;

export function cveRecord(run: CveRun, date: string, at: Date): HubRecord {
  const bySeverity: Record<string, number> = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of run.findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  const actionable = run.findings.filter(isActionable);
  return {
    id: date,
    generatedAt: at.toISOString(),
    complete: run.advisoryGaps.length === 0 && run.kevError === null,
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
    gaps: [...run.advisoryGaps, ...run.inventoryGaps, ...(run.kevError ? [`CISA KEV not read: ${run.kevError}`] : [])].map((g) => g.slice(0, 200)),
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
