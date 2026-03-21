/**
 * Proxmox Investigators
 *
 * Investigation functions for Proxmox-related events.
 */

import type { MissionControlClient } from '../../clients/MissionControlClient.js';
import type { InfraEvent } from '../eventStream.js';
import type { TriageReport } from '../triageHandler.js';

/**
 * Investigate Proxmox node status warning/critical.
 * Checks CPU/memory/disk across all nodes.
 */
export async function investigateProxmoxNodeStatus(
  event: InfraEvent,
  client: MissionControlClient,
): Promise<TriageReport> {
  const findings: string[] = [];

  try {
    const { data: nodes } = await client.getProxmoxNodes();

    for (const node of nodes) {
      const cpuPct = node.cpu !== undefined ? (node.cpu * 100).toFixed(1) : 'N/A';
      const memPct =
        node.mem !== undefined && node.maxmem
          ? ((node.mem / node.maxmem) * 100).toFixed(1)
          : 'N/A';
      const diskPct =
        node.disk !== undefined && node.maxdisk
          ? ((node.disk / node.maxdisk) * 100).toFixed(1)
          : 'N/A';

      findings.push(
        `${node.node}: status=${node.status ?? 'unknown'}, CPU=${cpuPct}%, RAM=${memPct}%, Disk=${diskPct}%`,
      );
    }
  } catch {
    findings.push('Could not fetch Proxmox node status.');
  }

  return {
    summary: 'Proxmox node resource check completed.',
    findings,
    suggestedRemediation: 'No auto-remediation — manual review recommended.',
  };
}

/**
 * Investigate Proxmox VM/LXC status event.
 * Checks the node where the VM/LXC runs for resource pressure.
 */
export async function investigateProxmoxVMStatus(
  event: InfraEvent,
  client: MissionControlClient,
): Promise<TriageReport> {
  const vmName = event.affected_service ?? 'unknown';
  const findings: string[] = [];

  findings.push(`VM/LXC "${vmName}" status event: ${event.message}`);

  try {
    const { data: nodes } = await client.getProxmoxNodes();

    for (const node of nodes) {
      const cpuPct = node.cpu !== undefined ? (node.cpu * 100).toFixed(1) : 'N/A';
      const memPct =
        node.mem !== undefined && node.maxmem
          ? ((node.mem / node.maxmem) * 100).toFixed(1)
          : 'N/A';

      findings.push(`Host ${node.node}: CPU=${cpuPct}%, RAM=${memPct}%`);
    }
  } catch {
    findings.push('Could not fetch Proxmox node status.');
  }

  return {
    summary: `Proxmox VM/LXC "${vmName}" status change detected.`,
    findings,
    suggestedRemediation: 'No auto-remediation — review VM/LXC status.',
  };
}
