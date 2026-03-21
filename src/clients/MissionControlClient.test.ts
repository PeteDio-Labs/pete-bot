import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MissionControlClient } from './MissionControlClient.js';
import * as metrics from '../metrics/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _global = global as any;

describe('MissionControlClient', () => {
  let client: MissionControlClient;

  beforeEach(() => {
    vi.clearAllMocks();
    metrics.resetMetrics();
    client = new MissionControlClient('http://test-mc:3000', 'http://test-notif:3002');
  });

  describe('getInventory()', () => {
    it('returns parsed inventory', async () => {
      const mockInventory = {
        data: {
          hosts: [{ id: '1', name: 'node1', type: 'k8s-node', status: 'online' }],
          workloads: [{ id: '2', name: 'app1', type: 'k8s-deployment', status: 'running' }],
        },
      };

      _global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockInventory,
      });

      const result = await client.getInventory();

      expect(result).toEqual(mockInventory);
      expect(_global.fetch).toHaveBeenCalledWith(
        'http://test-mc:3000/api/v1/inventory',
        expect.any(Object)
      );
    });
  });

  describe('getArgoApps()', () => {
    it('returns app status list', async () => {
      const mockApps = {
        data: [
          { name: 'blog-dev', syncStatus: 'Synced', healthStatus: 'Healthy' },
        ],
      };

      _global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockApps,
      });

      const result = await client.getArgoApps();

      expect(result).toEqual(mockApps);
      expect(_global.fetch).toHaveBeenCalledWith(
        'http://test-mc:3000/api/v1/argocd/applications',
        expect.any(Object)
      );
    });
  });

  describe('getArgoAppStatus()', () => {
    it('returns single app status', async () => {
      const mockApp = {
        data: { name: 'blog-dev', syncStatus: 'Synced', healthStatus: 'Healthy' },
      };

      _global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockApp,
      });

      const result = await client.getArgoAppStatus('blog-dev');

      expect(result).toEqual(mockApp);
      expect(_global.fetch).toHaveBeenCalledWith(
        'http://test-mc:3000/api/v1/argocd/applications/blog-dev',
        expect.any(Object)
      );
    });

    it('encodes app name in URL', async () => {
      _global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: {} }),
      });

      await client.getArgoAppStatus('app with spaces');

      expect(_global.fetch).toHaveBeenCalledWith(
        'http://test-mc:3000/api/v1/argocd/applications/app%20with%20spaces',
        expect.any(Object)
      );
    });
  });

  describe('syncArgoApp()', () => {
    it('sends POST request', async () => {
      const mockResult = { data: { success: true, message: 'Sync initiated' } };

      _global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockResult,
      });

      const result = await client.syncArgoApp('blog-dev');

      expect(result).toEqual(mockResult);
      expect(_global.fetch).toHaveBeenCalledWith(
        'http://test-mc:3000/api/v1/argocd/applications/blog-dev/sync',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('getProxmoxNodes()', () => {
    it('returns node list', async () => {
      const mockNodes = {
        data: [{ node: 'pedro', status: 'online', cpu: 0.15, maxcpu: 8 }],
      };

      _global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockNodes,
      });

      const result = await client.getProxmoxNodes();

      expect(result).toEqual(mockNodes);
      expect(_global.fetch).toHaveBeenCalledWith(
        'http://test-mc:3000/api/v1/proxmox/nodes',
        expect.any(Object)
      );
    });
  });

  describe('getRecentEvents()', () => {
    it('fetches from notification service URL', async () => {
      const mockEvents = {
        data: [{ id: '1', source: 'kubernetes', type: 'deployment', severity: 'info', message: 'test' }],
      };

      _global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockEvents,
      });

      const result = await client.getRecentEvents(5);

      expect(result).toEqual(mockEvents);
      expect(_global.fetch).toHaveBeenCalledWith(
        'http://test-notif:3002/api/v1/events?limit=5',
        expect.any(Object)
      );
    });

    it('uses default limit of 10', async () => {
      _global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await client.getRecentEvents();

      expect(_global.fetch).toHaveBeenCalledWith(
        'http://test-notif:3002/api/v1/events?limit=10',
        expect.any(Object)
      );
    });
  });

  describe('isAvailable()', () => {
    it('returns true when API responds', async () => {
      _global.fetch = vi.fn().mockResolvedValueOnce({ ok: true });

      const result = await client.isAvailable();

      expect(result).toBe(true);
      expect(_global.fetch).toHaveBeenCalledWith(
        'http://test-mc:3000/api/v1/argocd/status',
        expect.any(Object)
      );
    });

    it('returns false on connection error', async () => {
      _global.fetch = vi.fn().mockRejectedValueOnce(new Error('Connection failed'));

      const result = await client.isAvailable();

      expect(result).toBe(false);
    });

    it('returns false on non-200 status', async () => {
      _global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await client.isAvailable();

      expect(result).toBe(false);
    });
  });

  describe('metrics', () => {
    it('records request duration on each call', async () => {
      _global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await client.getArgoApps();

      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('mission_control_request_duration_seconds');
    });

    it('sets availability gauge to 1 on success', async () => {
      _global.fetch = vi.fn().mockResolvedValueOnce({ ok: true });

      await client.isAvailable();

      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('mission_control_available 1');
    });

    it('sets availability gauge to 0 on failure', async () => {
      _global.fetch = vi.fn().mockRejectedValueOnce(new Error('Failed'));

      await client.isAvailable();

      const metricsOutput = await metrics.getMetrics();
      expect(metricsOutput).toContain('mission_control_available 0');
    });
  });

  describe('error handling', () => {
    it('throws on non-OK response', async () => {
      _global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(client.getInventory()).rejects.toThrow('Mission Control API error');
    });

    it('throws on network error', async () => {
      _global.fetch = vi.fn().mockRejectedValueOnce(new Error('Network error'));

      await expect(client.getInventory()).rejects.toThrow('Failed to fetch from Mission Control');
    });

    it('throws on notification service error', async () => {
      _global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      await expect(client.getRecentEvents()).rejects.toThrow('Notification Service API error');
    });
  });
});
