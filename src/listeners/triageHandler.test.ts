import { describe, it, expect, vi } from 'vitest';
import { triageEvent } from './triageHandler.js';
import type { InfraEvent } from './eventStream.js';
import type { MissionControlClient } from '../clients/MissionControlClient.js';

function mockClient(overrides: Partial<MissionControlClient> = {}): MissionControlClient {
  return {
    getArgoAppStatus: vi.fn().mockResolvedValue({
      data: {
        name: 'test-app',
        namespace: 'default',
        syncStatus: 'OutOfSync',
        healthStatus: 'Healthy',
        resources: [
          { kind: 'Deployment', name: 'web', status: 'OutOfSync', health: 'Healthy' },
        ],
      },
    }),
    getArgoAppHistory: vi.fn().mockResolvedValue({ data: [] }),
    getPodLogs: vi.fn().mockResolvedValue({ data: { logs: 'error: connection refused\ninfo: starting' } }),
    getNodeCPU: vi.fn().mockResolvedValue({ data: [{ labels: { instance: 'node1' }, value: 0.5, timestamp: 0 }] }),
    getNodeMemory: vi.fn().mockResolvedValue({ data: [{ labels: { instance: 'node1' }, value: 0.6, timestamp: 0 }] }),
    getProxmoxNodes: vi.fn().mockResolvedValue({
      data: [{ node: 'pve01', status: 'online', cpu: 0.3, mem: 4000000000, maxmem: 8000000000, disk: 100000000, maxdisk: 500000000 }],
    }),
    ...overrides,
  } as unknown as MissionControlClient;
}

describe('triageEvent', () => {
  it('should return null for info events', async () => {
    const event: InfraEvent = {
      source: 'kubernetes',
      type: 'deployment',
      severity: 'info',
      message: 'Deployed successfully',
    };
    const result = await triageEvent(event, mockClient());
    expect(result).toBeNull();
  });

  it('should investigate argocd sync-drift events', async () => {
    const event: InfraEvent = {
      source: 'argocd',
      type: 'sync-drift',
      severity: 'warning',
      message: 'App drifted',
      affected_service: 'test-app',
    };
    const client = mockClient();
    const result = await triageEvent(event, client);

    expect(result).not.toBeNull();
    expect(result!.summary).toContain('test-app');
    expect(result!.findings.length).toBeGreaterThan(0);
    expect(result!.remediationAction).toBe('sync_app');
    expect(client.getArgoAppStatus).toHaveBeenCalledWith('test-app');
  });

  it('should investigate kubernetes deployment events', async () => {
    const event: InfraEvent = {
      source: 'kubernetes',
      type: 'deployment',
      severity: 'warning',
      message: 'Deployment restarted',
      affected_service: 'my-svc',
      namespace: 'prod',
    };
    const client = mockClient();
    const result = await triageEvent(event, client);

    expect(result).not.toBeNull();
    expect(result!.summary).toContain('my-svc');
    expect(result!.findings.length).toBeGreaterThan(0);
    expect(client.getPodLogs).toHaveBeenCalledWith('prod', 'my-svc', 30);
  });

  it('should propose restart for crashloop events', async () => {
    const event: InfraEvent = {
      source: 'kubernetes',
      type: 'deployment',
      severity: 'critical',
      message: 'Pod in CrashLoopBackOff',
      affected_service: 'broken-svc',
      namespace: 'default',
    };
    const result = await triageEvent(event, mockClient());

    expect(result).not.toBeNull();
    expect(result!.remediationAction).toBe('restart_deployment');
    expect(result!.remediationParams).toEqual({ namespace: 'default', name: 'broken-svc' });
  });

  it('should investigate proxmox node-status events', async () => {
    const event: InfraEvent = {
      source: 'proxmox',
      type: 'node-status',
      severity: 'warning',
      message: 'High memory usage on pve01',
    };
    const client = mockClient();
    const result = await triageEvent(event, client);

    expect(result).not.toBeNull();
    expect(result!.findings.length).toBeGreaterThan(0);
    expect(client.getProxmoxNodes).toHaveBeenCalled();
  });

  it('should return null for unmapped event types', async () => {
    const event = {
      source: 'unknown',
      type: 'whatever',
      severity: 'warning',
      message: 'Something happened',
    } as unknown as InfraEvent;
    const result = await triageEvent(event, mockClient());
    expect(result).toBeNull();
  });

  it('should handle investigation timeout', async () => {
    const slowClient = mockClient({
      getArgoAppStatus: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5000)),
      ),
    });

    const event: InfraEvent = {
      source: 'argocd',
      type: 'sync-drift',
      severity: 'warning',
      message: 'Slow investigation',
      affected_service: 'test-app',
    };

    const result = await triageEvent(event, slowClient, 100); // 100ms timeout
    expect(result).not.toBeNull();
    expect(result!.error).toContain('timed out');
  });

  it('should handle investigation errors gracefully', async () => {
    const errorClient = mockClient({
      getArgoAppStatus: vi.fn().mockRejectedValue(new Error('Network error')),
    });

    const event: InfraEvent = {
      source: 'argocd',
      type: 'sync-drift',
      severity: 'critical',
      message: 'Drift detected',
      affected_service: 'broken-app',
    };

    const result = await triageEvent(event, errorClient);
    expect(result).not.toBeNull();
    expect(result!.error).toContain('Investigation failed');
  });
});
