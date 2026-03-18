import { BaseTool } from './BaseTool.js';
import { missionControlClient } from '../clients/index.js';
import type { ToolSchema, ToolResult } from '../ai/types.js';

export interface MissionControlToolArgs {
  action:
    // Inventory
    | 'inventory_summary'
    | 'workload_status'
    // ArgoCD
    | 'list_apps'
    | 'app_status'
    | 'sync_app'
    | 'app_history'
    | 'refresh_app'
    // Proxmox
    | 'node_status'
    | 'start_vm'
    | 'stop_vm'
    | 'start_lxc'
    | 'stop_lxc'
    // Events
    | 'recent_events'
    // Prometheus
    | 'cluster_health'
    | 'node_cpu'
    | 'node_memory'
    | 'pv_usage'
    // qBittorrent
    | 'torrent_list'
    | 'torrent_details'
    | 'transfer_speeds'
    // K8s
    | 'restart_deployment'
    | 'pod_logs'
    // Meta
    | 'availability';
  app?: string;
  namespace?: string;
  limit?: number;
  hash?: string;
  filter?: string;
  node?: string;
  vmid?: string;
  name?: string;
  lines?: number;
}

export class MissionControlTool extends BaseTool<MissionControlToolArgs> {
  readonly name = 'mission_control';

  readonly schema: ToolSchema = {
    name: 'mission_control',
    description:
      'Unified tool for all infrastructure operations: inventory, ArgoCD, Proxmox, Prometheus metrics, qBittorrent torrents, K8s operations, and events. All data flows through Mission Control Backend.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform',
          enum: [
            'inventory_summary', 'workload_status',
            'list_apps', 'app_status', 'sync_app', 'app_history', 'refresh_app',
            'node_status', 'start_vm', 'stop_vm', 'start_lxc', 'stop_lxc',
            'recent_events',
            'cluster_health', 'node_cpu', 'node_memory', 'pv_usage',
            'torrent_list', 'torrent_details', 'transfer_speeds',
            'restart_deployment', 'pod_logs',
            'availability',
          ],
        },
        app: {
          type: 'string',
          description: 'ArgoCD application name (for app_status, sync_app, app_history, refresh_app)',
        },
        namespace: {
          type: 'string',
          description: 'Namespace filter (for workload_status, restart_deployment, pod_logs)',
        },
        limit: {
          type: 'number',
          description: 'Number of recent events (for recent_events, default: 10)',
        },
        hash: {
          type: 'string',
          description: 'Torrent hash (for torrent_details)',
        },
        filter: {
          type: 'string',
          description: 'Filter (for torrent_list: downloading|seeding|completed|paused|active)',
        },
        node: {
          type: 'string',
          description: 'Proxmox node name (for start_vm, stop_vm, start_lxc, stop_lxc)',
        },
        vmid: {
          type: 'string',
          description: 'VM or LXC ID (for start_vm, stop_vm, start_lxc, stop_lxc)',
        },
        name: {
          type: 'string',
          description: 'Resource name (for restart_deployment, pod_logs)',
        },
        lines: {
          type: 'number',
          description: 'Number of log lines (for pod_logs, default: 100)',
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
        case 'app_history':
          return await this.handleAppHistory(args.app);
        case 'refresh_app':
          return await this.handleRefreshApp(args.app);
        case 'node_status':
          return await this.handleNodeStatus();
        case 'start_vm':
          return await this.handleVMAction('start', args.node, args.vmid);
        case 'stop_vm':
          return await this.handleVMAction('stop', args.node, args.vmid);
        case 'start_lxc':
          return await this.handleLXCAction('start', args.node, args.vmid);
        case 'stop_lxc':
          return await this.handleLXCAction('stop', args.node, args.vmid);
        case 'recent_events':
          return await this.handleRecentEvents(args.limit);
        case 'cluster_health':
          return await this.handleClusterHealth();
        case 'node_cpu':
          return await this.handleNodeCPU();
        case 'node_memory':
          return await this.handleNodeMemory();
        case 'pv_usage':
          return await this.handlePVUsage();
        case 'torrent_list':
          return await this.handleTorrentList(args.filter);
        case 'torrent_details':
          return await this.handleTorrentDetails(args.hash);
        case 'transfer_speeds':
          return await this.handleTransferSpeeds();
        case 'restart_deployment':
          return await this.handleRestartDeployment(args.namespace, args.name);
        case 'pod_logs':
          return await this.handlePodLogs(args.namespace, args.name, args.lines);
        case 'availability':
          return await this.handleAvailability();
        default:
          return { success: false, error: `Unknown action: ${args.action}` };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Mission Control tool error: ${errorMessage}` };
    }
  }

  // ── Inventory ──────────────────────────────────────────────

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

  // ── ArgoCD ─────────────────────────────────────────────────

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
      return { success: false, error: 'Application name is required for app_status action' };
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
      return { success: false, error: 'Application name is required for sync_app action' };
    }

    const response = await missionControlClient.syncArgoApp(app);
    const result = response.data;

    if (!result.success) {
      return { success: false, error: result.error || `Sync failed for ${app}` };
    }

    return { success: true, action: 'sync_app', app, message: result.message };
  }

  private async handleAppHistory(app?: string): Promise<ToolResult> {
    if (!app) {
      return { success: false, error: 'Application name is required for app_history action' };
    }

    const response = await missionControlClient.getArgoAppHistory(app);
    return { success: true, action: 'app_history', app, history: response.data };
  }

  private async handleRefreshApp(app?: string): Promise<ToolResult> {
    if (!app) {
      return { success: false, error: 'Application name is required for refresh_app action' };
    }

    const response = await missionControlClient.refreshArgoApp(app);
    return { success: true, action: 'refresh_app', app, result: response.data };
  }

  // ── Proxmox ────────────────────────────────────────────────

  private async handleNodeStatus(): Promise<ToolResult> {
    const response = await missionControlClient.getProxmoxNodes();
    const nodes = response.data;

    return {
      success: true,
      action: 'node_status',
      count: Array.isArray(nodes) ? nodes.length : 0,
      nodes: (Array.isArray(nodes) ? nodes : []).map((node) => ({
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

  private async handleVMAction(action: 'start' | 'stop', node?: string, vmid?: string): Promise<ToolResult> {
    if (!node || !vmid) {
      return { success: false, error: `Proxmox node and vmid are required for ${action}_vm` };
    }
    const response = action === 'start'
      ? await missionControlClient.startVM(node, vmid)
      : await missionControlClient.stopVM(node, vmid);
    return { success: true, action: `${action}_vm`, node, vmid, result: response.data };
  }

  private async handleLXCAction(action: 'start' | 'stop', node?: string, vmid?: string): Promise<ToolResult> {
    if (!node || !vmid) {
      return { success: false, error: `Proxmox node and vmid are required for ${action}_lxc` };
    }
    const response = action === 'start'
      ? await missionControlClient.startLXC(node, vmid)
      : await missionControlClient.stopLXC(node, vmid);
    return { success: true, action: `${action}_lxc`, node, vmid, result: response.data };
  }

  // ── Events ─────────────────────────────────────────────────

  private async handleRecentEvents(limit = 10): Promise<ToolResult> {
    const response = await missionControlClient.getRecentEvents(limit);
    const events = response.data;

    if (!Array.isArray(events) || events.length === 0) {
      return { success: true, action: 'recent_events', count: 0, events: [], message: 'No recent events found' };
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

  // ── Prometheus ─────────────────────────────────────────────

  private async handleClusterHealth(): Promise<ToolResult> {
    const response = await missionControlClient.getClusterHealth();
    return { success: true, action: 'cluster_health', ...response.data };
  }

  private async handleNodeCPU(): Promise<ToolResult> {
    const response = await missionControlClient.getNodeCPU();
    return { success: true, action: 'node_cpu', metrics: response.data };
  }

  private async handleNodeMemory(): Promise<ToolResult> {
    const response = await missionControlClient.getNodeMemory();
    return { success: true, action: 'node_memory', metrics: response.data };
  }

  private async handlePVUsage(): Promise<ToolResult> {
    const response = await missionControlClient.getPVUsage();
    return { success: true, action: 'pv_usage', metrics: response.data };
  }

  // ── qBittorrent ────────────────────────────────────────────

  private async handleTorrentList(filter?: string): Promise<ToolResult> {
    const response = await missionControlClient.getTorrents(filter);
    const torrents = response.data;
    return {
      success: true,
      action: 'torrent_list',
      filter: filter || 'all',
      count: torrents.length,
      torrents: torrents.map((t) => ({
        hash: t.hash,
        name: t.name,
        state: t.state,
        progress: Math.round(t.progress * 100),
        dl_speed: t.dl_speed,
        up_speed: t.up_speed,
        size: t.size,
      })),
    };
  }

  private async handleTorrentDetails(hash?: string): Promise<ToolResult> {
    if (!hash) {
      return { success: false, error: 'Torrent hash is required for torrent_details action' };
    }
    const response = await missionControlClient.getTorrentDetails(hash);
    return { success: true, action: 'torrent_details', ...response.data };
  }

  private async handleTransferSpeeds(): Promise<ToolResult> {
    const response = await missionControlClient.getTransferInfo();
    return { success: true, action: 'transfer_speeds', ...response.data };
  }

  // ── K8s ────────────────────────────────────────────────────

  private async handleRestartDeployment(namespace?: string, name?: string): Promise<ToolResult> {
    if (!namespace || !name) {
      return { success: false, error: 'Namespace and deployment name are required for restart_deployment' };
    }
    const response = await missionControlClient.restartDeployment(namespace, name);
    return { success: true, action: 'restart_deployment', namespace, name, result: response.data };
  }

  private async handlePodLogs(namespace?: string, name?: string, lines?: number): Promise<ToolResult> {
    if (!namespace || !name) {
      return { success: false, error: 'Namespace and pod name are required for pod_logs' };
    }
    const response = await missionControlClient.getPodLogs(namespace, name, lines);
    return { success: true, action: 'pod_logs', namespace, name, logs: response.data.logs };
  }

  // ── Meta ───────────────────────────────────────────────────

  private async handleAvailability(): Promise<ToolResult> {
    const available = await missionControlClient.isAvailable();
    return { success: true, action: 'availability', available };
  }
}

export default new MissionControlTool();
