import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventDedup } from './eventDedup.js';

describe('EventDedup', () => {
  let dedup: EventDedup;

  beforeEach(() => {
    dedup = new EventDedup(1000); // 1 second window for fast tests
  });

  afterEach(() => {
    dedup.destroy();
  });

  it('should allow first occurrence of an event', () => {
    const result = dedup.isDuplicate('kubernetes', 'deployment', 'my-app', 'default');
    expect(result).toBeNull();
  });

  it('should detect duplicate within window', () => {
    dedup.isDuplicate('kubernetes', 'deployment', 'my-app', 'default');
    const result = dedup.isDuplicate('kubernetes', 'deployment', 'my-app', 'default');
    expect(result).not.toBeNull();
    expect(result!.count).toBe(2);
  });

  it('should track count across multiple duplicates', () => {
    dedup.isDuplicate('argocd', 'sync-drift', 'app1');
    dedup.isDuplicate('argocd', 'sync-drift', 'app1');
    const result = dedup.isDuplicate('argocd', 'sync-drift', 'app1');
    expect(result).not.toBeNull();
    expect(result!.count).toBe(3);
  });

  it('should treat different events as distinct', () => {
    dedup.isDuplicate('kubernetes', 'deployment', 'app-a', 'default');
    const result = dedup.isDuplicate('kubernetes', 'deployment', 'app-b', 'default');
    expect(result).toBeNull(); // different service = not a dup
  });

  it('should treat different sources as distinct', () => {
    dedup.isDuplicate('kubernetes', 'deployment', 'my-app');
    const result = dedup.isDuplicate('argocd', 'deployment', 'my-app');
    expect(result).toBeNull();
  });

  it('should allow event again after window expires', async () => {
    dedup.isDuplicate('kubernetes', 'pod-failure', 'svc');

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 1100));

    const result = dedup.isDuplicate('kubernetes', 'pod-failure', 'svc');
    expect(result).toBeNull(); // expired, treated as new
  });

  it('should build correct dedup keys', () => {
    expect(EventDedup.buildKey('k8s', 'deploy', 'svc', 'ns')).toBe('k8s|deploy|svc|ns');
    expect(EventDedup.buildKey('k8s', 'deploy')).toBe('k8s|deploy||');
    expect(EventDedup.buildKey('k8s', 'deploy', undefined, 'ns')).toBe('k8s|deploy||ns');
  });

  it('should prune expired entries', async () => {
    dedup.isDuplicate('kubernetes', 'a', 'svc');
    dedup.isDuplicate('kubernetes', 'b', 'svc');
    expect(dedup.size).toBe(2);

    await new Promise((r) => setTimeout(r, 1100));
    dedup.prune();

    expect(dedup.size).toBe(0);
  });

  it('should return entry from getEntry', () => {
    dedup.isDuplicate('argocd', 'sync-drift', 'app1');
    const entry = dedup.getEntry('argocd', 'sync-drift', 'app1');
    expect(entry).toBeDefined();
    expect(entry!.count).toBe(1);
  });

  it('should clean up on destroy', () => {
    dedup.isDuplicate('kubernetes', 'deployment', 'svc');
    dedup.destroy();
    expect(dedup.size).toBe(0);
  });
});
