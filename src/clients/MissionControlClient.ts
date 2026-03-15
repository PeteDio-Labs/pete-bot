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

/**
 * HTTP client for Mission Control Backend API and Notification Service
 */
export class MissionControlClient {
  private mcHost: string;
  private notifHost: string;
  private timeout: number = 10000;

  constructor(mcHost: string, notifHost: string) {
    this.mcHost = mcHost;
    this.notifHost = notifHost;
  }

  async getInventory(): Promise<InventoryResponse> {
    return this.makeRequest<InventoryResponse>('/api/v1/inventory');
  }

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

  async getProxmoxNodes(): Promise<{ data: ProxmoxNode[] }> {
    return this.makeRequest<{ data: ProxmoxNode[] }>('/api/v1/proxmox/nodes');
  }

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
