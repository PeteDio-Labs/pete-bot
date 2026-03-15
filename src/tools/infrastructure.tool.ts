import { BaseTool } from './BaseTool.js';
import { missionControlClient } from '../clients/index.js';
import type { ToolSchema, ToolResult } from '../ai/types.js';

export interface InfrastructureToolArgs {
  action: 'inventory_summary' | 'node_status' | 'workload_status';
  node?: string;
  namespace?: string;
}

class InfrastructureTool extends BaseTool<InfrastructureToolArgs> {
  readonly name = 'infrastructure';

  readonly schema: ToolSchema = {
    name: 'infrastructure',
    description:
      'Check Kubernetes hosts, pods, deployments, Proxmox nodes, and workload status across the homelab.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform',
          enum: ['inventory_summary', 'node_status', 'workload_status'],
        },
        node: {
          type: 'string',
          description: 'Proxmox node name (used with node_status action)',
        },
        namespace: {
          type: 'string',
          description: 'Filter workloads by namespace (used with workload_status action)',
        },
      },
      required: ['action'],
    },
  };

  async execute(args: InfrastructureToolArgs): Promise<ToolResult> {
    try {
      switch (args.action) {
        case 'inventory_summary':
          return await this.handleInventorySummary();
        case 'node_status':
          return await this.handleNodeStatus();
        case 'workload_status':
          return await this.handleWorkloadStatus(args.namespace);
        default:
          return { success: false, error: `Unknown action: ${args.action}` };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Infrastructure tool error: ${msg}` };
    }
  }

  private async handleInventorySummary(): Promise<ToolResult> {
    const inventory = await missionControlClient.getInventory();
    const { hosts, workloads } = inventory.data;

    const hostsByStatus: Record<string, number> = {};
    for (const h of hosts) {
      hostsByStatus[h.status] = (hostsByStatus[h.status] || 0) + 1;
    }

    const workloadsByStatus: Record<string, number> = {};
    for (const w of workloads) {
      workloadsByStatus[w.status] = (workloadsByStatus[w.status] || 0) + 1;
    }

    return {
      success: true,
      action: 'inventory_summary',
      totalHosts: hosts.length,
      hostsByStatus,
      totalWorkloads: workloads.length,
      workloadsByStatus,
      hosts: hosts.map((h) => ({
        name: h.name,
        type: h.type,
        status: h.status,
        cluster: h.cluster,
      })),
    };
  }

  private async handleNodeStatus(): Promise<ToolResult> {
    const response = await missionControlClient.getProxmoxNodes();
    const nodes = response.data;

    return {
      success: true,
      action: 'node_status',
      count: nodes.length,
      nodes: nodes.map((n) => ({
        node: n.node,
        status: n.status,
        cpu: n.cpu != null ? Math.round(n.cpu * 100) : null,
        memUsedPct: n.mem != null && n.maxmem ? Math.round((n.mem / n.maxmem) * 100) : null,
        maxcpu: n.maxcpu,
        maxmem: n.maxmem,
        uptime: n.uptime,
      })),
    };
  }

  private async handleWorkloadStatus(namespace?: string): Promise<ToolResult> {
    const inventory = await missionControlClient.getInventory();
    let workloads = inventory.data.workloads;

    if (namespace) {
      workloads = workloads.filter((w) => w.namespace === namespace);
    }

    return {
      success: true,
      action: 'workload_status',
      namespace: namespace || 'all',
      count: workloads.length,
      workloads: workloads.map((w) => ({
        name: w.name,
        type: w.type,
        status: w.status,
        namespace: w.namespace,
        health: w.health_status,
      })),
    };
  }
}

export default new InfrastructureTool();
