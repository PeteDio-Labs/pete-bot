import { BaseTool } from './BaseTool.js';
import { missionControlClient } from '../clients/index.js';
import type { ToolSchema, ToolResult } from '../ai/types.js';

export interface MissionControlToolArgs {
  action:
    | 'inventory_summary'
    | 'workload_status'
    | 'list_apps'
    | 'app_status'
    | 'sync_app'
    | 'node_status'
    | 'recent_events'
    | 'availability';
  app?: string;
  namespace?: string;
  limit?: number;
}

export class MissionControlTool extends BaseTool<MissionControlToolArgs> {
  readonly name = 'mission_control';

  readonly schema: ToolSchema = {
    name: 'mission_control',
    description:
      'Query Mission Control for infrastructure inventory, workload health, ArgoCD application status, Proxmox node status, recent events, and service availability. Supports syncing an ArgoCD app when needed.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform',
          enum: [
            'inventory_summary',
            'workload_status',
            'list_apps',
            'app_status',
            'sync_app',
            'node_status',
            'recent_events',
            'availability',
          ],
        },
        app: {
          type: 'string',
          description: 'ArgoCD application name (required for app_status and sync_app)',
        },
        namespace: {
          type: 'string',
          description: 'Namespace filter for workload_status',
        },
        limit: {
          type: 'number',
          description: 'Number of recent events to retrieve for recent_events (default: 10)',
        },
      },
      required: ['action'],
    },
  };

  async execute(args: MissionControlToolArgs): Promise<ToolResult> {
    try {
      switch (args.action) {
        case 'inventory_summary':
          return await this.handleInventorySummary();
        case 'workload_status':
          return await this.handleWorkloadStatus(args.namespace);
        case 'list_apps':
          return await this.handleListApps();
        case 'app_status':
          return await this.handleAppStatus(args.app);
        case 'sync_app':
          return await this.handleSyncApp(args.app);
        case 'node_status':
          return await this.handleNodeStatus();
        case 'recent_events':
          return await this.handleRecentEvents(args.limit);
        case 'availability':
          return await this.handleAvailability();
        default:
          return {
            success: false,
            error: `Unknown action: ${args.action}`,
          };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Mission Control tool error: ${errorMessage}`,
      };
    }
  }

  private async handleInventorySummary(): Promise<ToolResult> {
    const inventory = await missionControlClient.getInventory();
    const { hosts, workloads } = inventory.data;

    const hostsByStatus: Record<string, number> = {};
    for (const host of hosts) {
      hostsByStatus[host.status] = (hostsByStatus[host.status] || 0) + 1;
    }

    const workloadsByStatus: Record<string, number> = {};
    for (const workload of workloads) {
      workloadsByStatus[workload.status] = (workloadsByStatus[workload.status] || 0) + 1;
    }

    return {
      success: true,
      action: 'inventory_summary',
      totalHosts: hosts.length,
      hostsByStatus,
      totalWorkloads: workloads.length,
      workloadsByStatus,
      hosts: hosts.map((host) => ({
        id: host.id,
        name: host.name,
        type: host.type,
        status: host.status,
        cluster: host.cluster,
      })),
    };
  }

  private async handleWorkloadStatus(namespace?: string): Promise<ToolResult> {
    const inventory = await missionControlClient.getInventory();
    let workloads = inventory.data.workloads;

    if (namespace) {
      workloads = workloads.filter((workload) => workload.namespace === namespace);
    }

    return {
      success: true,
      action: 'workload_status',
      namespace: namespace || 'all',
      count: workloads.length,
      workloads: workloads.map((workload) => ({
        id: workload.id,
        name: workload.name,
        type: workload.type,
        status: workload.status,
        namespace: workload.namespace,
        health: workload.health_status,
      })),
    };
  }

  private async handleListApps(): Promise<ToolResult> {
    const response = await missionControlClient.getArgoApps();
    const apps = response.data;

    return {
      success: true,
      action: 'list_apps',
      count: Array.isArray(apps) ? apps.length : 0,
      apps: (Array.isArray(apps) ? apps : []).map((app) => ({
        name: app.name,
        namespace: app.namespace,
        sync: app.syncStatus,
        health: app.healthStatus,
        revision: app.revision?.substring(0, 8),
        message: app.message,
      })),
    };
  }

  private async handleAppStatus(app?: string): Promise<ToolResult> {
    if (!app) {
      return {
        success: false,
        error: 'Application name is required for app_status action',
      };
    }

    const response = await missionControlClient.getArgoAppStatus(app);
    const status = response.data;

    return {
      success: true,
      action: 'app_status',
      app: status.name,
      namespace: status.namespace,
      sync: status.syncStatus,
      health: status.healthStatus,
      revision: status.revision,
      message: status.message,
      resourceCount: status.resources?.length || 0,
      resources: status.resources?.map((resource) => ({
        kind: resource.kind,
        name: resource.name,
        namespace: resource.namespace,
        status: resource.status,
        health: resource.health,
      })),
    };
  }

  private async handleSyncApp(app?: string): Promise<ToolResult> {
    if (!app) {
      return {
        success: false,
        error: 'Application name is required for sync_app action',
      };
    }

    const response = await missionControlClient.syncArgoApp(app);
    const result = response.data;

    if (!result.success) {
      return {
        success: false,
        error: result.error || `Sync failed for ${app}`,
      };
    }

    return {
      success: true,
      action: 'sync_app',
      app,
      message: result.message,
    };
  }

  private async handleNodeStatus(): Promise<ToolResult> {
    const response = await missionControlClient.getProxmoxNodes();
    const nodes = response.data;

    return {
      success: true,
      action: 'node_status',
      count: nodes.length,
      nodes: nodes.map((node) => ({
        node: node.node,
        status: node.status,
        cpu: node.cpu != null ? Math.round(node.cpu * 100) : null,
        memUsedPct: node.mem != null && node.maxmem ? Math.round((node.mem / node.maxmem) * 100) : null,
        diskUsedPct: node.disk != null && node.maxdisk ? Math.round((node.disk / node.maxdisk) * 100) : null,
        maxcpu: node.maxcpu,
        maxmem: node.maxmem,
        maxdisk: node.maxdisk,
        uptime: node.uptime,
      })),
    };
  }

  private async handleRecentEvents(limit = 10): Promise<ToolResult> {
    const response = await missionControlClient.getRecentEvents(limit);
    const events = response.data;

    if (!Array.isArray(events) || events.length === 0) {
      return {
        success: true,
        action: 'recent_events',
        count: 0,
        events: [],
        message: 'No recent events found',
      };
    }

    return {
      success: true,
      action: 'recent_events',
      count: events.length,
      events: events.map((event) => ({
        id: event.id,
        source: event.source,
        type: event.type,
        severity: event.severity,
        message: event.message,
        timestamp: event.timestamp,
      })),
    };
  }

  private async handleAvailability(): Promise<ToolResult> {
    const available = await missionControlClient.isAvailable();

    return {
      success: true,
      action: 'availability',
      available,
    };
  }
}

export default new MissionControlTool();