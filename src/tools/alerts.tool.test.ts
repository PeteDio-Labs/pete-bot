import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AlertsToolArgs } from './alerts.tool.js';
import * as metrics from '../metrics/index.js';
import { missionControlClient } from '../clients/index.js';

vi.mock('../clients/index.js', () => ({
  missionControlClient: {
    getRecentEvents: vi.fn(),
  },
}));

const { default: tool } = await import('./alerts.tool.js');

describe('AlertsTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metrics.resetMetrics();
  });

  describe('tool metadata', () => {
    it('has correct name', () => {
      expect(tool.name).toBe('alerts');
    });

    it('has correct schema', () => {
      expect(tool.schema.name).toBe('alerts');
      expect(tool.schema.description).toContain('alerts');
      const actionProp = tool.schema.parameters.properties['action'];
      if (actionProp && 'enum' in actionProp) {
        const enumValues = (actionProp as { enum: string[] }).enum;
        expect(enumValues).toContain('recent_events');
      }
      expect(tool.schema.parameters.required).toContain('action');
    });
  });

  describe('recent_events action', () => {
    it('returns events list', async () => {
      (missionControlClient.getRecentEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: [
          { id: '1', source: 'kubernetes', type: 'deployment', severity: 'info', message: 'Inventory sync completed', timestamp: '2026-03-15T10:00:00Z' },
          { id: '2', source: 'argocd', type: 'rollout', severity: 'info', message: 'Sync triggered for blog-dev', timestamp: '2026-03-15T09:30:00Z' },
        ],
      });

      const result = await tool.execute({ action: 'recent_events' });

      expect(result.success).toBe(true);
      expect(result).toMatchObject({ action: 'recent_events', count: 2 });
      const events = (result as unknown as { events: unknown[] }).events;
      expect(events[0]).toEqual({
        source: 'kubernetes',
        type: 'deployment',
        severity: 'info',
        message: 'Inventory sync completed',
        timestamp: '2026-03-15T10:00:00Z',
      });
    });

    it('returns empty message when no events', async () => {
      (missionControlClient.getRecentEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: [],
      });

      const result = await tool.execute({ action: 'recent_events' });

      expect(result.success).toBe(true);
      expect(result).toMatchObject({ action: 'recent_events', count: 0 });
    });

    it('passes custom limit', async () => {
      (missionControlClient.getRecentEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: [],
      });

      await tool.execute({ action: 'recent_events', limit: 5 });

      expect(missionControlClient.getRecentEvents).toHaveBeenCalledWith(5);
    });

    it('uses default limit of 10', async () => {
      (missionControlClient.getRecentEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: [],
      });

      await tool.execute({ action: 'recent_events' });

      expect(missionControlClient.getRecentEvents).toHaveBeenCalledWith(10);
    });
  });

  describe('error handling', () => {
    it('returns error result when client throws', async () => {
      (missionControlClient.getRecentEvents as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Connection refused')
      );

      const result = await tool.execute({ action: 'recent_events' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Connection refused');
      }
    });

    it('returns error on invalid action', async () => {
      const result = await tool.execute(
        { action: 'invalid' } as unknown as AlertsToolArgs
      );

      expect(result.success).toBe(false);
    });
  });
});
