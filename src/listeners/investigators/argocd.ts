/**
 * ArgoCD Investigators
 *
 * Investigation functions for ArgoCD-related events.
 */

import type { MissionControlClient } from '../../clients/MissionControlClient.js';
import type { InfraEvent } from '../eventStream.js';
import type { TriageReport } from '../triageHandler.js';

/**
 * Investigate ArgoCD sync drift.
 * Checks app sync status and lists out-of-sync resources.
 */
export async function investigateArgoCDSyncDrift(
  event: InfraEvent,
  client: MissionControlClient,
): Promise<TriageReport> {
  const appName = event.affected_service ?? event.metadata?.app as string | undefined;
  if (!appName) {
    return {
      summary: 'ArgoCD sync drift detected but no app name available.',
      findings: ['Event did not include an affected_service or app name.'],
    };
  }

  const { data: status } = await client.getArgoAppStatus(appName);
  const findings: string[] = [];

  findings.push(`App "${appName}" sync: ${status.syncStatus}, health: ${status.healthStatus}`);

  if (status.resources) {
    const outOfSync = status.resources.filter(
      (r) => r.status === 'OutOfSync' || r.health === 'Degraded',
    );
    if (outOfSync.length > 0) {
      for (const r of outOfSync.slice(0, 5)) {
        findings.push(
          `${r.kind}/${r.name}${r.namespace ? ` (${r.namespace})` : ''} — status: ${r.status ?? 'unknown'}, health: ${r.health ?? 'unknown'}`,
        );
      }
      if (outOfSync.length > 5) {
        findings.push(`...and ${outOfSync.length - 5} more out-of-sync resources`);
      }
    }
  }

  const needsSync = status.syncStatus === 'OutOfSync';

  return {
    summary: `ArgoCD app "${appName}" is ${status.syncStatus} / ${status.healthStatus}.`,
    findings,
    suggestedRemediation: needsSync ? `Sync ${appName}?` : undefined,
    remediationAction: needsSync ? 'sync_app' : undefined,
    remediationParams: needsSync ? { name: appName } : undefined,
  };
}

/**
 * Investigate ArgoCD rollout failure.
 * Checks app health and recent history.
 */
export async function investigateArgoCDRollout(
  event: InfraEvent,
  client: MissionControlClient,
): Promise<TriageReport> {
  const appName = event.affected_service ?? event.metadata?.app as string | undefined;
  if (!appName) {
    return {
      summary: 'ArgoCD rollout event but no app name available.',
      findings: ['Event did not include an affected_service or app name.'],
    };
  }

  const [statusResult, historyResult] = await Promise.all([
    client.getArgoAppStatus(appName),
    client.getArgoAppHistory(appName),
  ]);

  const status = statusResult.data;
  const history = historyResult.data;
  const findings: string[] = [];

  findings.push(`App "${appName}" sync: ${status.syncStatus}, health: ${status.healthStatus}`);

  if (status.message) {
    findings.push(`Message: ${status.message}`);
  }

  if (Array.isArray(history) && history.length > 0) {
    const recent = history.slice(0, 3);
    findings.push(`Recent deployments: ${recent.length} in history`);
  }

  const isDegraded = status.healthStatus === 'Degraded' || status.healthStatus === 'Missing';

  return {
    summary: `ArgoCD rollout for "${appName}" — health: ${status.healthStatus}.`,
    findings,
    suggestedRemediation: isDegraded
      ? `App is degraded. Consider syncing or rolling back.`
      : undefined,
  };
}
