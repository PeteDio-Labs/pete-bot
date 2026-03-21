import { mcRequestDuration, mcAvailable } from '../metrics/index.js';

export interface InventoryResponse {
  data: {
    hosts: HostInfo[];
    workloads: WorkloadInfo[];
  };
}

export interface HostInfo {
  id: string;
  name: string;
  type: string;
  cluster: string | null;
  status: string;
  addresses: Record<string, string>;
  metadata: Record<string, unknown>;
}

export interface WorkloadInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  namespace: string | null;
  health_status: string;
  spec: Record<string, unknown>;
}

export interface ArgoAppStatus {
  name: string;
  namespace: string;
  syncStatus: string;
  healthStatus: string;
  revision?: string;
  message?: string;
  resources?: Array<{
    kind: string;
    name: string;
    namespace?: string;
    status?: string;
    health?: string;
  }>;
}

export interface SyncResult {
  success: boolean;
  message?: string;
  error?: string;
}

export interface ProxmoxNode {
  node: string;
  status?: string;
  maxcpu?: number;
  maxmem?: number;
  maxdisk?: number;
  cpu?: number;
  mem?: number;
  disk?: number;
  uptime?: number;
}

export interface InfraEvent {
  id: string;
  source: string;
  type: string;
  severity: string;
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface TorrentInfo {
  hash: string;
  name: string;
  state: string;
  progress: number;
  dl_speed: number;
  up_speed: number;
  size?: number;
}

export interface TorrentProperties {
  hash: string;
  name: string;
  comment: string;
  total_size: number;
  total_downloaded: number;
  total_uploaded: number;
  addition_date: number;
  completion_date: number;
}

export interface TransferInfo {
  dl_info_speed: number;
  up_info_speed: number;
  total_uploaded: number;
  total_downloaded: number;
  dht_nodes: number;
}

export interface MetricResult {
  labels: Record<string, string>;
  timestamp: number;
  value: number;
}

export interface HealthMetrics {
  clusterHealthy: boolean;
  apiServerUp: boolean;
  nodeCount: number;
  nodesReady: number;
  podCount: number;
  podsRunning: number;
  timestamp: number;
}

export interface OperationResult {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * HTTP client for Mission Control Backend API and Notification Service
 * This is the single integration point for all infrastructure operations.
 */
export class MissionControlClient {
  private mcHost: string;
  private notifHost: string;
  private timeout: number = 10000;

  constructor(mcHost: string, notifHost: string) {
    this.mcHost = mcHost;
    this.notifHost = notifHost;
  }

  // ── Inventory ──────────────────────────────────────────────

  async getInventory(): Promise<InventoryResponse> {
    return this.makeRequest<InventoryResponse>('/api/v1/inventory');
  }

  // ── ArgoCD ─────────────────────────────────────────────────

  async getArgoApps(): Promise<{ data: ArgoAppStatus[] }> {
    return this.makeRequest<{ data: ArgoAppStatus[] }>('/api/v1/argocd/applications');
  }

  async getArgoAppStatus(name: string): Promise<{ data: ArgoAppStatus }> {
    return this.makeRequest<{ data: ArgoAppStatus }>(`/api/v1/argocd/applications/${encodeURIComponent(name)}`);
  }

  async syncArgoApp(name: string): Promise<{ data: SyncResult }> {
    return this.makeRequest<{ data: SyncResult }>(
      `/api/v1/argocd/applications/${encodeURIComponent(name)}/sync`,
      'POST'
    );
  }

  async getArgoAppHistory(name: string): Promise<{ data: unknown[] }> {
    return this.makeRequest<{ data: unknown[] }>(`/api/v1/argocd/applications/${encodeURIComponent(name)}/history`);
  }

  async refreshArgoApp(name: string): Promise<{ data: SyncResult }> {
    return this.makeRequest<{ data: SyncResult }>(
      `/api/v1/argocd/applications/${encodeURIComponent(name)}/refresh`,
      'POST'
    );
  }

  // ── Proxmox ────────────────────────────────────────────────

  async getProxmoxNodes(): Promise<{ data: ProxmoxNode[] }> {
    return this.makeRequest<{ data: ProxmoxNode[] }>('/api/v1/proxmox/nodes');
  }

  async startVM(node: string, vmid: string): Promise<{ data: OperationResult }> {
    return this.makeRequest<{ data: OperationResult }>(
      `/api/v1/proxmox/nodes/${encodeURIComponent(node)}/vms/${encodeURIComponent(vmid)}/start`,
      'POST'
    );
  }

  async stopVM(node: string, vmid: string): Promise<{ data: OperationResult }> {
    return this.makeRequest<{ data: OperationResult }>(
      `/api/v1/proxmox/nodes/${encodeURIComponent(node)}/vms/${encodeURIComponent(vmid)}/stop`,
      'POST'
    );
  }

  async startLXC(node: string, vmid: string): Promise<{ data: OperationResult }> {
    return this.makeRequest<{ data: OperationResult }>(
      `/api/v1/proxmox/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(vmid)}/start`,
      'POST'
    );
  }

  async stopLXC(node: string, vmid: string): Promise<{ data: OperationResult }> {
    return this.makeRequest<{ data: OperationResult }>(
      `/api/v1/proxmox/nodes/${encodeURIComponent(node)}/lxc/${encodeURIComponent(vmid)}/stop`,
      'POST'
    );
  }

  // ── qBittorrent (via MC Backend) ──────────────────────────

  async getTorrents(filter?: string): Promise<{ data: TorrentInfo[] }> {
    const path = filter
      ? `/api/v1/qbittorrent/torrents?filter=${encodeURIComponent(filter)}`
      : '/api/v1/qbittorrent/torrents';
    return this.makeRequest<{ data: TorrentInfo[] }>(path);
  }

  async getTorrentDetails(hash: string): Promise<{ data: TorrentProperties }> {
    return this.makeRequest<{ data: TorrentProperties }>(`/api/v1/qbittorrent/torrents/${encodeURIComponent(hash)}`);
  }

  async getTransferInfo(): Promise<{ data: TransferInfo }> {
    return this.makeRequest<{ data: TransferInfo }>('/api/v1/qbittorrent/transfer');
  }

  // ── Prometheus (via MC Backend) ────────────────────────────

  async getClusterHealth(): Promise<{ data: HealthMetrics }> {
    return this.makeRequest<{ data: HealthMetrics }>('/api/v1/prometheus/cluster/health');
  }

  async getNodeCPU(): Promise<{ data: MetricResult[] }> {
    return this.makeRequest<{ data: MetricResult[] }>('/api/v1/prometheus/nodes/cpu');
  }

  async getNodeMemory(): Promise<{ data: MetricResult[] }> {
    return this.makeRequest<{ data: MetricResult[] }>('/api/v1/prometheus/nodes/memory');
  }

  async getPVUsage(): Promise<{ data: MetricResult[] }> {
    return this.makeRequest<{ data: MetricResult[] }>('/api/v1/prometheus/pvs');
  }

  // ── Kubernetes (via MC Backend) ────────────────────────────

  async restartDeployment(namespace: string, name: string): Promise<{ data: OperationResult }> {
    return this.makeRequest<{ data: OperationResult }>(
      `/api/v1/kubernetes/deployments/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/restart`,
      'POST'
    );
  }

  async getPodLogs(namespace: string, name: string, lines = 100): Promise<{ data: { logs: string } }> {
    return this.makeRequest<{ data: { logs: string } }>(
      `/api/v1/kubernetes/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/logs?lines=${lines}`
    );
  }

  // ── Events (Notification Service) ─────────────────────────

  async getRecentEvents(limit = 10): Promise<{ data: InfraEvent[] }> {
    const url = `${this.notifHost}/api/v1/events?limit=${limit}`;
    const start = Date.now();

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeout),
      });

      const duration = (Date.now() - start) / 1000;
      mcRequestDuration.observe(duration);

      if (!response.ok) {
        throw new Error(`Notification Service API error: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as { data: InfraEvent[] };
    } catch (error: unknown) {
      const duration = (Date.now() - start) / 1000;
      mcRequestDuration.observe(duration);

      if (error instanceof Error) {
        throw new Error(`Failed to fetch from Notification Service: ${error.message}`);
      }
      throw error;
    }
  }

  // ── Event Publishing (Notification Service) ────────────────

  async publishEvent(event: {
    source: string;
    type: string;
    severity: string;
    message: string;
    namespace?: string;
    affected_service?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    const url = `${this.notifHost}/api/v1/events`;
    const start = Date.now();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(this.timeout),
      });

      const duration = (Date.now() - start) / 1000;
      mcRequestDuration.observe(duration);

      if (!response.ok) {
        throw new Error(`Notification Service API error: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as { id: string };
    } catch (error: unknown) {
      const duration = (Date.now() - start) / 1000;
      mcRequestDuration.observe(duration);

      if (error instanceof Error) {
        throw new Error(`Failed to publish event: ${error.message}`);
      }
      throw error;
    }
  }

  // ── Workload Status (Kubernetes) ─────────────────────────

  async getWorkloadStatus(namespace?: string): Promise<{ data: unknown }> {
    const path = namespace
      ? `/api/v1/inventory/workloads?namespace=${encodeURIComponent(namespace)}`
      : '/api/v1/inventory/workloads';
    return this.makeRequest<{ data: unknown }>(path);
  }

  // ── Meta ───────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    try {
      const start = Date.now();
      const response = await fetch(`${this.mcHost}/api/v1/argocd/status`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeout),
      });

      const duration = (Date.now() - start) / 1000;
      mcRequestDuration.observe(duration);

      if (response.ok) {
        mcAvailable.set(1);
        return true;
      } else {
        mcAvailable.set(0);
        return false;
      }
    } catch {
      mcAvailable.set(0);
      return false;
    }
  }

  private async makeRequest<T>(endpoint: string, method = 'GET'): Promise<T> {
    const url = `${this.mcHost}${endpoint}`;
    const start = Date.now();

    try {
      const response = await fetch(url, {
        method,
        signal: AbortSignal.timeout(this.timeout),
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' } } : {}),
      });

      const duration = (Date.now() - start) / 1000;
      mcRequestDuration.observe(duration);

      if (!response.ok) {
        throw new Error(
          `Mission Control API error: ${response.status} ${response.statusText}`
        );
      }

      return (await response.json()) as T;
    } catch (error: unknown) {
      const duration = (Date.now() - start) / 1000;
      mcRequestDuration.observe(duration);

      if (error instanceof Error) {
        throw new Error(`Failed to fetch from Mission Control: ${error.message}`);
      }
      throw error;
    }
  }
}
