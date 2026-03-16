import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InfrastructureToolArgs } from './infrastructure.tool.js';
import * as metrics from '../metrics/index.js';
import { missionControlClient } from '../clients/index.js';

vi.mock('../clients/index.js', () => ({
  missionControlClient: {
    getInventory: vi.fn(),
    getProxmoxNodes: vi.fn(),
  },
}));

// Import after mock setup
const { default: tool } = await import('./infrastructure.tool.js');

describe('InfrastructureTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metrics.resetMetrics();
  });

  describe('tool metadata', () => {
    it('has correct name', () => {
      expect(tool.name).toBe('infrastructure');
    });

    it('has correct schema', () => {
      expect(tool.schema.name).toBe('infrastructure');
      expect(tool.schema.description).toContain('Kubernetes');
      const actionProp = tool.schema.parameters.properties['action'];
      if (actionProp && 'enum' in actionProp) {
        const enumValues = (actionProp as { enum: string[] }).enum;
        expect(enumValues).toContain('inventory_summary');
        expect(enumValues).toContain('node_status');
        expect(enumValues).toContain('workload_status');
      }
      expect(tool.schema.parameters.required).toContain('action');
    });
  });

  describe('inventory_summary action', () => {
    it('returns structured summary', async () => {
      (missionControlClient.getInventory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: {
          hosts: [
            { id: '1', name: 'node1', type: 'k8s-node', status: 'online', cluster: 'microk8s' },
            { id: '2', name: 'node2', type: 'proxmox-node', status: 'online', cluster: null },
          ],
          workloads: [
            { id: '3', name: 'app1', type: 'k8s-deployment', status: 'running', namespace: 'default', health_status: 'healthy' },
            { id: '4', name: 'app2', type: 'k8s-deployment', status: 'running', namespace: 'blog', health_status: 'healthy' },
            { id: '5', name: 'app3', type: 'k8s-deployment', status: 'failed', namespace: 'test', health_status: 'unhealthy' },
          ],
        },
      });

      const result = await tool.execute({ action: 'inventory_summary' });

      expect(result.success).toBe(true);
      expect(result).toMatchObject({
        action: 'inventory_summary',
        totalHosts: 2,
        hostsByStatus: { online: 2 },
        totalWorkloads: 3,
        workloadsByStatus: { running: 2, failed: 1 },
      });
    });
  });

  describe('node_status action', () => {
    it('returns proxmox node data', async () => {
      (missionControlClient.getProxmoxNodes as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: [
          { node: 'pve01', status: 'online', cpu: 0.15, maxcpu: 8, mem: 8589934592, maxmem: 34359738368, uptime: 86400 },
        ],
      });

      const result = await tool.execute({ action: 'node_status' });

      expect(result.success).toBe(true);
      expect(result).toMatchObject({
        action: 'node_status',
        count: 1,
      });
      const nodes = (result as unknown as { nodes: unknown[] }).nodes;
      expect(nodes[0]).toMatchObject({
        node: 'pve01',
        status: 'online',
        cpu: 15,
        memUsedPct: 25,
      });
    });
  });

  describe('workload_status action', () => {
    it('returns all workloads when no namespace filter', async () => {
      (missionControlClient.getInventory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: {
          hosts: [],
          workloads: [
            { id: '1', name: 'app1', type: 'k8s-deployment', status: 'running', namespace: 'blog', health_status: 'healthy' },
            { id: '2', name: 'app2', type: 'k8s-deployment', status: 'running', namespace: 'discord-bot', health_status: 'healthy' },
          ],
        },
      });

      const result = await tool.execute({ action: 'workload_status' });

      expect(result.success).toBe(true);
      expect(result).toMatchObject({ action: 'workload_status', namespace: 'all', count: 2 });
    });

    it('filters by namespace', async () => {
      (missionControlClient.getInventory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: {
          hosts: [],
          workloads: [
            { id: '1', name: 'app1', type: 'k8s-deployment', status: 'running', namespace: 'blog', health_status: 'healthy' },
            { id: '2', name: 'app2', type: 'k8s-deployment', status: 'running', namespace: 'discord-bot', health_status: 'healthy' },
          ],
        },
      });

      const result = await tool.execute({ action: 'workload_status', namespace: 'blog' });

      expect(result.success).toBe(true);
      expect(result).toMatchObject({ action: 'workload_status', namespace: 'blog', count: 1 });
    });
  });

  describe('error handling', () => {
    it('returns error result when client throws', async () => {
      (missionControlClient.getInventory as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Connection refused')
      );

      const result = await tool.execute({ action: 'inventory_summary' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Connection refused');
      }
    });

    it('returns error on invalid action', async () => {
      const result = await tool.execute(
        { action: 'invalid' } as unknown as InfrastructureToolArgs
      );

      expect(result.success).toBe(false);
    });
  });
});
