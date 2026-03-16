import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MissionControlTool, type MissionControlToolArgs } from './mission-control.tool.js';
import * as metrics from '../metrics/index.js';
import { missionControlClient } from '../clients/index.js';

vi.mock('../clients/index.js', () => ({
  missionControlClient: {
    getInventory: vi.fn(),
    getArgoApps: vi.fn(),
    getArgoAppStatus: vi.fn(),
    syncArgoApp: vi.fn(),
    getProxmoxNodes: vi.fn(),
    getRecentEvents: vi.fn(),
    isAvailable: vi.fn(),
  },
}));

describe('MissionControlTool', () => {
  let tool: MissionControlTool;

  beforeEach(() => {
    vi.clearAllMocks();
    metrics.resetMetrics();
    tool = new MissionControlTool();
  });

  describe('tool metadata', () => {
    it('has correct name', () => {
      expect(tool.name).toBe('mission_control');
    });

    it('has correct schema', () => {
      expect(tool.schema.name).toBe('mission_control');
      expect(tool.schema.description).toContain('Mission Control');
      const actionProp = tool.schema.parameters.properties['action'];
      if (actionProp && 'enum' in actionProp) {
        const enumValues = (actionProp as { enum: string[] }).enum;
        expect(enumValues).toContain('inventory_summary');
        expect(enumValues).toContain('workload_status');
        expect(enumValues).toContain('list_apps');
        expect(enumValues).toContain('app_status');
        expect(enumValues).toContain('sync_app');
        expect(enumValues).toContain('node_status');
        expect(enumValues).toContain('recent_events');
        expect(enumValues).toContain('availability');
      }
      expect(tool.schema.parameters.required).toContain('action');
    });
  });

  describe('execute action validation', () => {
    it('returns error on invalid action', async () => {
      const result = await tool.execute(
        { action: 'invalid_action' } as unknown as MissionControlToolArgs
      );

      expect(result.success).toBe(false);
    });

    it('returns error without app for app_status action', async () => {
      const result = await tool.execute(
        { action: 'app_status' } as unknown as MissionControlToolArgs
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Application name');
      }
    });

    it('returns error without app for sync_app action', async () => {
      const result = await tool.execute(
        { action: 'sync_app' } as unknown as MissionControlToolArgs
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Application name');
      }
    });
  });

  describe('inventory_summary action', () => {
    it('returns structured inventory summary', async () => {
      (missionControlClient.getInventory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: {
          hosts: [
            { id: '1', name: 'node1', type: 'k8s-node', status: 'online', cluster: 'microk8s' },
            { id: '2', name: 'node2', type: 'proxmox-node', status: 'offline', cluster: null },
          ],
          workloads: [
            { id: '3', name: 'app1', type: 'k8s-deployment', status: 'running', namespace: 'default', health_status: 'healthy' },
            { id: '4', name: 'app2', type: 'k8s-job', status: 'failed', namespace: 'blog', health_status: 'unhealthy' },
          ],
        },
      });

      const result = await tool.execute({ action: 'inventory_summary' });

      expect(result.success).toBe(true);
      expect(result).toMatchObject({
        action: 'inventory_summary',
        totalHosts: 2,
        hostsByStatus: { online: 1, offline: 1 },
        totalWorkloads: 2,
        workloadsByStatus: { running: 1, failed: 1 },
      });
    });
  });

  describe('workload_status action', () => {
    it('returns workloads with namespace filter support', async () => {
      (missionControlClient.getInventory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: {
          hosts: [],
          workloads: [
            { id: '1', name: 'blog-api', type: 'k8s-deployment', status: 'running', namespace: 'blog', health_status: 'healthy' },
            { id: '2', name: 'discord-bot', type: 'k8s-deployment', status: 'running', namespace: 'bots', health_status: 'healthy' },
          ],
        },
      });

      const result = await tool.execute({ action: 'workload_status', namespace: 'blog' });

      expect(result.success).toBe(true);
      expect(result).toMatchObject({
        action: 'workload_status',
        namespace: 'blog',
        count: 1,
      });
    });
  });

  describe('list_apps action', () => {
    it('returns compact ArgoCD app list', async () => {
      (missionControlClient.getArgoApps as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: [
          {
            name: 'blog-dev',
            namespace: 'argocd',
            syncStatus: 'Synced',
            healthStatus: 'Healthy',
            revision: 'abc12345def67890',
            message: 'Healthy',
          },
        ],
      });

      const result = await tool.execute({ action: 'list_apps' });

      expect(result.success).toBe(true);
      expect(result).toMatchObject({
        action: 'list_apps',
        count: 1,
      });
      const apps = (result as unknown as { apps: unknown[] }).apps;
      expect(apps[0]).toEqual({
        name: 'blog-dev',
        namespace: 'argocd',
        sync: 'Synced',
        health: 'Healthy',
        revision: 'abc12345',
        message: 'Healthy',
      });
    });
  });

  describe('app_status action', () => {
    it('returns detailed application status', async () => {
      (missionControlClient.getArgoAppStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: {
          name: 'blog-dev',
          namespace: 'argocd',
          syncStatus: 'Synced',
          healthStatus: 'Healthy',
          revision: 'abc12345',
          message: 'All resources healthy',
          resources: [
            { kind: 'Deployment', name: 'blog-api', namespace: 'blog', status: 'Synced', health: 'Healthy' },
          ],
        },
      });

      const result = await tool.execute({ action: 'app_status', app: 'blog-dev' });

      expect(result.success).toBe(true);
      expect(result).toMatchObject({
        action: 'app_status',
        app: 'blog-dev',
        namespace: 'argocd',
        sync: 'Synced',
        health: 'Healthy',
        resourceCount: 1,
      });
    });
  });

  describe('sync_app action', () => {
    it('returns sync success payload', async () => {
      (missionControlClient.syncArgoApp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { success: true, message: 'Sync initiated' },
      });

      const result = await tool.execute({ action: 'sync_app', app: 'blog-dev' });

      expect(result).toEqual({
        success: true,
        action: 'sync_app',
        app: 'blog-dev',
        message: 'Sync initiated',
      });
    });
  });

  describe('node_status action', () => {
    it('returns structured Proxmox node status', async () => {
      (missionControlClient.getProxmoxNodes as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: [
          {
            node: 'pve01',
            status: 'online',
            cpu: 0.5,
            mem: 8,
            maxmem: 16,
            disk: 50,
            maxdisk: 100,
            maxcpu: 8,
            uptime: 1234,
          },
        ],
      });

      const result = await tool.execute({ action: 'node_status' });

      expect(result.success).toBe(true);
      const nodes = (result as unknown as { nodes: unknown[] }).nodes;
      expect(nodes[0]).toEqual({
        node: 'pve01',
        status: 'online',
        cpu: 50,
        memUsedPct: 50,
        diskUsedPct: 50,
        maxcpu: 8,
        maxmem: 16,
        maxdisk: 100,
        uptime: 1234,
      });
    });
  });

  describe('recent_events action', () => {
    it('returns events and passes limit', async () => {
      (missionControlClient.getRecentEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: [
          {
            id: '1',
            source: 'argocd',
            type: 'sync',
            severity: 'info',
            message: 'Sync triggered',
            timestamp: '2026-03-16T10:00:00Z',
          },
        ],
      });

      const result = await tool.execute({ action: 'recent_events', limit: 5 });

      expect(missionControlClient.getRecentEvents).toHaveBeenCalledWith(5);
      expect(result).toMatchObject({
        success: true,
        action: 'recent_events',
        count: 1,
      });
    });

    it('returns empty event list message', async () => {
      (missionControlClient.getRecentEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: [],
      });

      const result = await tool.execute({ action: 'recent_events' });

      expect(result).toEqual({
        success: true,
        action: 'recent_events',
        count: 0,
        events: [],
        message: 'No recent events found',
      });
    });
  });

  describe('availability action', () => {
    it('returns Mission Control availability', async () => {
      (missionControlClient.isAvailable as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

      const result = await tool.execute({ action: 'availability' });

      expect(result).toEqual({
        success: true,
        action: 'availability',
        available: true,
      });
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
  });
});