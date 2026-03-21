/**
 * Health Poller
 *
 * Periodic background checks for infrastructure issues.
 * Publishes events to notification-service when anomalies are detected.
 *
 * Pollers:
 * - ArgoCD drift detection (every 5 min)
 * - K8s pod failure detection (every 2 min)
 * - Node resource pressure alerts (every 5 min)
 */

import { MissionControlClient } from '../clients/MissionControlClient.js';
import { healthPollerRuns, healthPollerEventsPublished } from '../metrics/index.js';
import { logger } from '../utils/index.js';

interface ArgoAppState {
  name: string;
  syncStatus: string;
  healthStatus: string;
}

interface PollerState {
  lastArgoStates: Map<string, ArgoAppState>;
  knownPodFailures: Set<string>;
  lastNodeAlert: Map<string, number>; // node → last alert timestamp
}

const state: PollerState = {
  lastArgoStates: new Map(),
  knownPodFailures: new Set(),
  lastNodeAlert: new Map(),
};

const ARGO_POLL_INTERVAL = 5 * 60 * 1000;   // 5 minutes
const POD_POLL_INTERVAL = 2 * 60 * 1000;     // 2 minutes
const RESOURCE_POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
const NODE_ALERT_COOLDOWN = 10 * 60 * 1000;   // 10 minutes between repeat alerts

// Thresholds
const CPU_WARNING = 0.80;
const CPU_CRITICAL = 0.95;
const MEM_WARNING = 0.85;
const MEM_CRITICAL = 0.95;

/**
 * Check ArgoCD apps for sync drift.
 * Compares current state to last known state — publishes event on drift.
 */
async function pollArgoCDDrift(client: MissionControlClient): Promise<void> {
  const pollerName = 'argocd-drift';
  try {
    const { data: apps } = await client.getArgoApps();

    for (const app of apps) {
      const prev = state.lastArgoStates.get(app.name);
      const current: ArgoAppState = {
        name: app.name,
        syncStatus: app.syncStatus,
        healthStatus: app.healthStatus,
      };

      // On first run, just record state
      if (!prev) {
        state.lastArgoStates.set(app.name, current);
        continue;
      }

      // Detect drift: was synced, now OutOfSync or Degraded
      const drifted =
        prev.syncStatus === 'Synced' && current.syncStatus === 'OutOfSync';
      const degraded =
        prev.healthStatus === 'Healthy' &&
        (current.healthStatus === 'Degraded' || current.healthStatus === 'Missing');

      if (drifted) {
        await client.publishEvent({
          source: 'argocd',
          type: 'sync-drift',
          severity: 'warning',
          message: `ArgoCD app "${app.name}" drifted to OutOfSync.`,
          affected_service: app.name,
          namespace: app.namespace,
          metadata: { previousSync: prev.syncStatus, currentSync: current.syncStatus },
        });
        healthPollerEventsPublished.inc({ poller: pollerName, severity: 'warning' });
        logger.info(`[HealthPoller] ArgoCD drift detected: ${app.name}`);
      }

      if (degraded) {
        await client.publishEvent({
          source: 'argocd',
          type: 'rollout',
          severity: 'critical',
          message: `ArgoCD app "${app.name}" health degraded to ${current.healthStatus}.`,
          affected_service: app.name,
          namespace: app.namespace,
          metadata: { previousHealth: prev.healthStatus, currentHealth: current.healthStatus },
        });
        healthPollerEventsPublished.inc({ poller: pollerName, severity: 'critical' });
        logger.info(`[HealthPoller] ArgoCD degradation detected: ${app.name}`);
      }

      state.lastArgoStates.set(app.name, current);
    }

    healthPollerRuns.inc({ poller: pollerName, result: 'success' });
  } catch (err) {
    healthPollerRuns.inc({ poller: pollerName, result: 'error' });
    logger.error(
      `[HealthPoller] ArgoCD drift check failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Check for K8s pod failures via inventory workload status.
 */
async function pollPodFailures(client: MissionControlClient): Promise<void> {
  const pollerName = 'pod-failures';
  try {
    const { data } = await client.getInventory();
    const workloads = data.workloads ?? [];

    const currentFailures = new Set<string>();

    for (const workload of workloads) {
      const key = `${workload.namespace ?? 'default'}/${workload.name}`;

      if (
        workload.health_status === 'unhealthy' ||
        workload.status === 'failed'
      ) {
        currentFailures.add(key);

        // Only publish if this is a new failure
        if (!state.knownPodFailures.has(key)) {
          await client.publishEvent({
            source: 'kubernetes',
            type: 'pod-failure',
            severity: 'warning',
            message: `Workload "${workload.name}" is ${workload.health_status ?? workload.status} in ${workload.namespace ?? 'default'}.`,
            affected_service: workload.name,
            namespace: workload.namespace ?? undefined,
            metadata: { status: workload.status, health: workload.health_status },
          });
          healthPollerEventsPublished.inc({ poller: pollerName, severity: 'warning' });
          logger.info(`[HealthPoller] Pod failure detected: ${key}`);
        }
      }
    }

    // Update known failures — clear resolved ones
    state.knownPodFailures = currentFailures;
    healthPollerRuns.inc({ poller: pollerName, result: 'success' });
  } catch (err) {
    healthPollerRuns.inc({ poller: pollerName, result: 'error' });
    logger.error(
      `[HealthPoller] Pod failure check failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Check node CPU and memory for resource pressure.
 */
async function pollResourcePressure(client: MissionControlClient): Promise<void> {
  const pollerName = 'resource-pressure';
  try {
    const [cpuResult, memResult] = await Promise.all([
      client.getNodeCPU(),
      client.getNodeMemoryRatio(),
    ]);

    const now = Date.now();

    for (const node of cpuResult.data) {
      const instance = node.labels.instance ?? 'unknown';
      const cpuValue = node.value;

      if (cpuValue >= CPU_CRITICAL) {
        if (shouldAlert(instance, 'cpu-critical', now)) {
          await client.publishEvent({
            source: 'kubernetes',
            type: 'node-status',
            severity: 'critical',
            message: `Node "${instance}" CPU at ${(cpuValue * 100).toFixed(1)}% — critical threshold exceeded.`,
            affected_service: instance,
            metadata: { cpu: cpuValue, threshold: CPU_CRITICAL },
          });
          healthPollerEventsPublished.inc({ poller: pollerName, severity: 'critical' });
        }
      } else if (cpuValue >= CPU_WARNING) {
        if (shouldAlert(instance, 'cpu-warning', now)) {
          await client.publishEvent({
            source: 'kubernetes',
            type: 'node-status',
            severity: 'warning',
            message: `Node "${instance}" CPU at ${(cpuValue * 100).toFixed(1)}% — warning threshold exceeded.`,
            affected_service: instance,
            metadata: { cpu: cpuValue, threshold: CPU_WARNING },
          });
          healthPollerEventsPublished.inc({ poller: pollerName, severity: 'warning' });
        }
      }
    }

    for (const node of memResult.data) {
      const instance = node.labels.instance ?? 'unknown';
      const memValue = node.value;

      if (memValue >= MEM_CRITICAL) {
        if (shouldAlert(instance, 'mem-critical', now)) {
          await client.publishEvent({
            source: 'kubernetes',
            type: 'node-status',
            severity: 'critical',
            message: `Node "${instance}" memory at ${(memValue * 100).toFixed(1)}% — critical threshold exceeded.`,
            affected_service: instance,
            metadata: { memory: memValue, threshold: MEM_CRITICAL },
          });
          healthPollerEventsPublished.inc({ poller: pollerName, severity: 'critical' });
        }
      } else if (memValue >= MEM_WARNING) {
        if (shouldAlert(instance, 'mem-warning', now)) {
          await client.publishEvent({
            source: 'kubernetes',
            type: 'node-status',
            severity: 'warning',
            message: `Node "${instance}" memory at ${(memValue * 100).toFixed(1)}% — warning threshold exceeded.`,
            affected_service: instance,
            metadata: { memory: memValue, threshold: MEM_WARNING },
          });
          healthPollerEventsPublished.inc({ poller: pollerName, severity: 'warning' });
        }
      }
    }

    healthPollerRuns.inc({ poller: pollerName, result: 'success' });
  } catch (err) {
    healthPollerRuns.inc({ poller: pollerName, result: 'error' });
    logger.error(
      `[HealthPoller] Resource pressure check failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Alert cooldown — prevent repeat alerts for the same node/metric.
 */
function shouldAlert(instance: string, metric: string, now: number): boolean {
  const key = `${instance}:${metric}`;
  const lastAlert = state.lastNodeAlert.get(key) ?? 0;
  if (now - lastAlert < NODE_ALERT_COOLDOWN) return false;
  state.lastNodeAlert.set(key, now);
  return true;
}

/**
 * Start all health pollers.
 */
export function startHealthPoller(client: MissionControlClient): void {
  logger.info('[HealthPoller] Starting health pollers');

  // Initial runs after a short delay (let SSE connect first)
  setTimeout(() => pollArgoCDDrift(client), 10_000);
  setTimeout(() => pollPodFailures(client), 15_000);
  setTimeout(() => pollResourcePressure(client), 20_000);

  // Periodic runs
  setInterval(() => pollArgoCDDrift(client), ARGO_POLL_INTERVAL);
  setInterval(() => pollPodFailures(client), POD_POLL_INTERVAL);
  setInterval(() => pollResourcePressure(client), RESOURCE_POLL_INTERVAL);

  logger.info(
    `[HealthPoller] Pollers scheduled: ArgoCD drift (${ARGO_POLL_INTERVAL / 1000}s), Pod failures (${POD_POLL_INTERVAL / 1000}s), Resources (${RESOURCE_POLL_INTERVAL / 1000}s)`,
  );
}
