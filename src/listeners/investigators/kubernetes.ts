/**
 * Kubernetes Investigators
 *
 * Investigation functions for Kubernetes-related events.
 */

import type { MissionControlClient } from '../../clients/MissionControlClient.js';
import type { InfraEvent } from '../eventStream.js';
import type { TriageReport } from '../triageHandler.js';

/**
 * Investigate a Kubernetes deployment restart event.
 * Checks workload status and fetches recent pod logs.
 */
export async function investigateDeploymentRestart(
  event: InfraEvent,
  client: MissionControlClient,
): Promise<TriageReport> {
  const namespace = event.namespace ?? 'default';
  const service = event.affected_service;
  const findings: string[] = [];

  if (!service) {
    return {
      summary: 'Deployment restart detected but no service name available.',
      findings: ['Event did not include an affected_service.'],
    };
  }

  // Try to get pod logs for the affected service
  try {
    const { data } = await client.getPodLogs(namespace, service, 30);
    const logs = data.logs;
    if (logs) {
      const logLines = logs.split('\n').filter(Boolean);
      const errorLines = logLines.filter(
        (l) => /error|fatal|panic|crash|exception/i.test(l),
      );

      if (errorLines.length > 0) {
        findings.push(`Found ${errorLines.length} error lines in recent logs:`);
        for (const line of errorLines.slice(0, 3)) {
          findings.push(`  ${line.slice(0, 200)}`);
        }
      } else {
        findings.push(`No errors found in last 30 log lines.`);
      }
    }
  } catch {
    findings.push('Could not fetch pod logs — pod may not be running.');
  }

  const isCrashLoop = event.message?.toLowerCase().includes('crashloop');

  return {
    summary: `Deployment "${service}" in ${namespace} was restarted.`,
    findings,
    suggestedRemediation: isCrashLoop
      ? `Restart deployment ${service}?`
      : undefined,
    remediationAction: isCrashLoop ? 'restart_deployment' : undefined,
    remediationParams: isCrashLoop
      ? { namespace, name: service }
      : undefined,
  };
}

/**
 * Investigate a Kubernetes pod failure.
 * Fetches pod logs and checks node resources.
 */
export async function investigatePodFailure(
  event: InfraEvent,
  client: MissionControlClient,
): Promise<TriageReport> {
  const namespace = event.namespace ?? 'default';
  const service = event.affected_service;
  const findings: string[] = [];

  if (!service) {
    return {
      summary: 'Pod failure detected but no service name available.',
      findings: ['Event did not include an affected_service.'],
    };
  }

  // Fetch logs
  try {
    const { data } = await client.getPodLogs(namespace, service, 50);
    const logs = data.logs;
    if (logs) {
      const logLines = logs.split('\n').filter(Boolean);
      const errorLines = logLines.filter(
        (l) => /error|fatal|panic|crash|exception|oom/i.test(l),
      );

      if (errorLines.length > 0) {
        findings.push(`Found ${errorLines.length} error lines in pod logs:`);
        for (const line of errorLines.slice(0, 5)) {
          findings.push(`  ${line.slice(0, 200)}`);
        }
      } else {
        findings.push('No obvious errors in recent pod logs.');
      }
    }
  } catch {
    findings.push('Could not fetch pod logs — pod may have been evicted.');
  }

  // Check node resource pressure
  try {
    const [cpuResult, memResult] = await Promise.all([
      client.getNodeCPU(),
      client.getNodeMemory(),
    ]);

    for (const node of cpuResult.data) {
      const cpuPct = (node.value * 100).toFixed(1);
      findings.push(
        `Node ${node.labels.instance ?? 'unknown'} CPU: ${cpuPct}%`,
      );
    }
    for (const node of memResult.data) {
      const memPct = (node.value * 100).toFixed(1);
      findings.push(
        `Node ${node.labels.instance ?? 'unknown'} Memory: ${memPct}%`,
      );
    }
  } catch {
    findings.push('Could not fetch node metrics.');
  }

  const isCrashLoop = event.message?.toLowerCase().includes('crashloop');

  return {
    summary: `Pod failure in "${service}" (${namespace}).`,
    findings,
    suggestedRemediation: isCrashLoop
      ? `Restart deployment ${service}?`
      : 'Review pod logs for root cause.',
    remediationAction: isCrashLoop ? 'restart_deployment' : undefined,
    remediationParams: isCrashLoop
      ? { namespace, name: service }
      : undefined,
  };
}
