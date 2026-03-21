/**
 * Triage Handler
 *
 * Maps event source/type + severity to investigation functions.
 * Each investigation calls MC Backend endpoints and returns a structured report.
 * Only triggers on warning and critical events.
 */

import { logger } from '../utils/index.js';
import {
  triageInvestigationsRun,
  triageInvestigationDuration,
} from '../metrics/index.js';
import { MissionControlClient } from '../clients/MissionControlClient.js';
import { investigateArgoCDSyncDrift, investigateArgoCDRollout } from './investigators/argocd.js';
import { investigateDeploymentRestart, investigatePodFailure } from './investigators/kubernetes.js';
import { investigateProxmoxNodeStatus, investigateProxmoxVMStatus } from './investigators/proxmox.js';
import type { InfraEvent } from './eventStream.js';

export interface TriageReport {
  summary: string;
  findings: string[];
  suggestedRemediation?: string;
  remediationAction?: string;
  remediationParams?: Record<string, string>;
  error?: string;
}

type InvestigationFn = (
  event: InfraEvent,
  client: MissionControlClient,
) => Promise<TriageReport>;

/**
 * Event-to-investigation mapping.
 * Key format: `source/type` or `source/*` for catch-all.
 */
const investigationMap: Record<string, InvestigationFn> = {
  'argocd/sync-drift': investigateArgoCDSyncDrift,
  'argocd/rollout': investigateArgoCDRollout,
  'kubernetes/deployment': investigateDeploymentRestart,
  'kubernetes/pod-failure': investigatePodFailure,
  'proxmox/node-status': investigateProxmoxNodeStatus,
  'proxmox/vm-status': investigateProxmoxVMStatus,
  'proxmox/lxc-status': investigateProxmoxVMStatus,
};

function getInvestigationFn(source: string, type: string): InvestigationFn | undefined {
  return investigationMap[`${source}/${type}`];
}

/**
 * Run triage investigation for an event.
 * Returns null if no investigation is mapped or severity is info.
 */
export async function triageEvent(
  event: InfraEvent,
  mcClient: MissionControlClient,
  timeoutMs = 10_000,
): Promise<TriageReport | null> {
  // Only investigate warning and critical
  if (event.severity === 'info') return null;

  const investigateFn = getInvestigationFn(event.source, event.type);
  if (!investigateFn) {
    logger.debug(`[Triage] No investigation mapped for ${event.source}/${event.type}`);
    return null;
  }

  const start = Date.now();
  const labels = { source: event.source, type: event.type };

  try {
    const report = await Promise.race([
      investigateFn(event, mcClient),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Investigation timed out')), timeoutMs),
      ),
    ]);

    const duration = (Date.now() - start) / 1000;
    triageInvestigationDuration.observe(labels, duration);
    triageInvestigationsRun.inc({ ...labels, result: 'success' });

    logger.info(`[Triage] ${event.source}/${event.type} completed in ${duration.toFixed(1)}s`);
    return report;
  } catch (err) {
    const duration = (Date.now() - start) / 1000;
    triageInvestigationDuration.observe(labels, duration);

    const isTimeout = err instanceof Error && err.message === 'Investigation timed out';
    triageInvestigationsRun.inc({ ...labels, result: isTimeout ? 'timeout' : 'error' });

    const errorMsg = isTimeout
      ? 'Auto-investigation timed out — manual check recommended'
      : `Investigation failed: ${err instanceof Error ? err.message : String(err)}`;

    logger.warn(`[Triage] ${event.source}/${event.type}: ${errorMsg}`);

    return {
      summary: `Investigation for ${event.source}/${event.type} did not complete.`,
      findings: [],
      error: errorMsg,
    };
  }
}
