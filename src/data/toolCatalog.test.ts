import { describe, it, expect } from 'vitest';
import { toolCatalog } from './toolCatalog.js';

describe('toolCatalog', () => {
  const expectedTools = [
    'mission_control',
    'qbittorrent',
    'infrastructure',
    'argocd',
    'alerts',
    'calculate',
    'get_current_time',
  ];

  it('should contain all expected tools', () => {
    for (const name of expectedTools) {
      expect(toolCatalog).toHaveProperty(name);
    }
  });

  it('should have valid entries for all tools', () => {
    for (const [, entry] of Object.entries(toolCatalog)) {
      expect(entry.summary).toBeTruthy();
      expect(['action-based', 'simple']).toContain(entry.type);
      expect(entry.examples.length).toBeGreaterThan(0);
    }
  });

  it('should have actions for action-based tools', () => {
    const actionBased = Object.entries(toolCatalog).filter(([, e]) => e.type === 'action-based');
    expect(actionBased.length).toBeGreaterThan(0);

    for (const [, entry] of actionBased) {
      expect(entry.actions).toBeDefined();
      expect(entry.actions!.length).toBeGreaterThan(0);

      for (const action of entry.actions!) {
        expect(action.name).toBeTruthy();
        expect(action.description).toBeTruthy();
        expect(Array.isArray(action.requiredParams)).toBe(true);
        expect(Array.isArray(action.optionalParams)).toBe(true);
      }
    }
  });

  it('should have parameters for simple tools', () => {
    const simple = Object.entries(toolCatalog).filter(([, e]) => e.type === 'simple');
    expect(simple.length).toBeGreaterThan(0);

    for (const [, entry] of simple) {
      expect(entry.parameters).toBeDefined();
      expect(entry.parameters!.length).toBeGreaterThan(0);
    }
  });

  it('should have correct mission_control actions', () => {
    const mc = toolCatalog.mission_control!;
    const actionNames = mc.actions!.map((a) => a.name);
    expect(actionNames).toContain('inventory_summary');
    expect(actionNames).toContain('list_apps');
    expect(actionNames).toContain('app_status');
    expect(actionNames).toContain('sync_app');
    expect(actionNames).toContain('node_status');
    expect(actionNames).toContain('recent_events');
    expect(actionNames).toContain('availability');
  });

  it('should have correct required params for app_status', () => {
    const mc = toolCatalog.mission_control!;
    const appStatus = mc.actions!.find((a) => a.name === 'app_status');
    expect(appStatus?.requiredParams).toContain('app');
  });

  it('should have notes for tools with state-changing actions', () => {
    expect(toolCatalog.mission_control!.notes).toContain('sync_app');
    expect(toolCatalog.argocd!.notes).toContain('state-changing');
  });
});
