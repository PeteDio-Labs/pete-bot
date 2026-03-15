import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ArgoCDToolArgs } from './argocd.tool.js';
import * as metrics from '../metrics/index.js';
import { missionControlClient } from '../clients/index.js';

vi.mock('../clients/index.js', () => ({
  missionControlClient: {
    getArgoApps: vi.fn(),
    getArgoAppStatus: vi.fn(),
    syncArgoApp: vi.fn(),
  },
}));

const { default: tool } = await import('./argocd.tool.js');

describe('ArgoCDTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metrics.resetMetrics();
  });

  describe('tool metadata', () => {
    it('has correct name', () => {
      expect(tool.name).toBe('argocd');
    });

    it('has correct schema', () => {
      expect(tool.schema.name).toBe('argocd');
      expect(tool.schema.description).toContain('ArgoCD');
      const actionProp = tool.schema.parameters.properties['action'];
      if (actionProp && 'enum' in actionProp) {
        const enumValues = (actionProp as { enum: string[] }).enum;
        expect(enumValues).toContain('list_apps');
        expect(enumValues).toContain('app_status');
        expect(enumValues).toContain('sync_app');
      }
      expect(tool.schema.parameters.required).toContain('action');
    });
  });

  describe('list_apps action', () => {
    it('returns app list with status', async () => {
      (missionControlClient.getArgoApps as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: [
          { name: 'blog-dev', syncStatus: 'Synced', healthStatus: 'Healthy', revision: 'abc12345def' },
          { name: 'discord-bot-dev', syncStatus: 'OutOfSync', healthStatus: 'Progressing', revision: '1234567890a' },
        ],
      });

      const result = await tool.execute({ action: 'list_apps' });

      expect(result.success).toBe(true);
      expect(result).toMatchObject({ action: 'list_apps', count: 2 });
      const apps = (result as unknown as { apps: unknown[] }).apps;
      expect(apps[0]).toEqual({
        name: 'blog-dev',
        sync: 'Synced',
        health: 'Healthy',
        revision: 'abc12345',
      });
    });
  });

  describe('app_status action', () => {
    it('returns detailed app status', async () => {
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
        sync: 'Synced',
        health: 'Healthy',
      });
    });

    it('returns error without app name', async () => {
      const result = await tool.execute({ action: 'app_status' } as unknown as ArgoCDToolArgs);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('required');
      }
    });
  });

  describe('sync_app action', () => {
    it('returns success on sync', async () => {
      (missionControlClient.syncArgoApp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { success: true, message: 'Sync operation initiated for blog-dev' },
      });

      const result = await tool.execute({ action: 'sync_app', app: 'blog-dev' });

      expect(result.success).toBe(true);
      expect(result).toMatchObject({
        action: 'sync_app',
        app: 'blog-dev',
      });
    });

    it('returns error on sync failure', async () => {
      (missionControlClient.syncArgoApp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: { success: false, error: 'App not found' },
      });

      const result = await tool.execute({ action: 'sync_app', app: 'nonexistent' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('App not found');
      }
    });

    it('returns error without app name', async () => {
      const result = await tool.execute({ action: 'sync_app' } as unknown as ArgoCDToolArgs);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('required');
      }
    });
  });

  describe('error handling', () => {
    it('returns error result when client throws', async () => {
      (missionControlClient.getArgoApps as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Connection refused')
      );

      const result = await tool.execute({ action: 'list_apps' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Connection refused');
      }
    });

    it('returns error on invalid action', async () => {
      const result = await tool.execute(
        { action: 'invalid' } as unknown as ArgoCDToolArgs
      );

      expect(result.success).toBe(false);
    });
  });
});
