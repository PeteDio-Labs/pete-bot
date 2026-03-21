/**
 * Remediation DB Tests
 *
 * These tests must run with `bun test` (not vitest) because
 * they use the bun:sqlite built-in module.
 *
 * Run: bun test src/db/remediations.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { RemediationDB } from './remediations.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('RemediationDB', () => {
  let db: RemediationDB;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'remediation-test-'));
    db = new RemediationDB(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    db.destroy();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create a remediation task', () => {
    const task = db.create({
      eventId: 'evt-1',
      action: 'sync_app',
      actionParams: { name: 'my-app' },
      affectedService: 'my-app',
    });

    expect(task.id).toBeDefined();
    expect(task.state).toBe('pending');
    expect(task.action).toBe('sync_app');
    expect(task.params).toEqual({ name: 'my-app' });
    expect(task.affected_service).toBe('my-app');
  });

  it('should retrieve a task by ID', () => {
    const created = db.create({
      eventId: 'evt-1',
      action: 'restart_deployment',
      actionParams: { namespace: 'default', name: 'svc' },
      affectedService: 'svc',
    });

    const found = db.getById(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.action).toBe('restart_deployment');
  });

  it('should return null for unknown ID', () => {
    const found = db.getById('nonexistent');
    expect(found).toBeNull();
  });

  it('should detect active remediation for service', () => {
    db.create({
      eventId: 'evt-1',
      action: 'sync_app',
      actionParams: { name: 'app' },
      affectedService: 'app',
    });

    expect(db.hasActiveForService('app')).toBe(true);
    expect(db.hasActiveForService('other-app')).toBe(false);
  });

  it('should transition task states', () => {
    const task = db.create({
      eventId: 'evt-1',
      action: 'sync_app',
      actionParams: { name: 'app' },
      affectedService: 'app',
    });

    const approved = db.updateState(task.id, 'approved', { resolvedBy: 'user123' });
    expect(approved!.state).toBe('approved');

    const complete = db.updateState(task.id, 'complete', { result: 'Synced OK' });
    expect(complete!.state).toBe('complete');
    expect(complete!.resolved_at).not.toBeNull();
    expect(complete!.result).toBe('Synced OK');
  });

  it('should not allow multiple active remediations for same service', () => {
    db.create({
      eventId: 'evt-1',
      action: 'sync_app',
      actionParams: { name: 'app' },
      affectedService: 'my-service',
    });

    expect(db.hasActiveForService('my-service')).toBe(true);

    // Completing the first task should allow new ones
    const tasks = db.getRecent();
    db.updateState(tasks[0]!.id, 'complete');
    expect(db.hasActiveForService('my-service')).toBe(false);
  });

  it('should find task by Discord message ID', () => {
    const task = db.create({
      eventId: 'evt-1',
      action: 'sync_app',
      actionParams: { name: 'app' },
      affectedService: 'app',
    });

    db.setDiscordMessageId(task.id, 'msg-123');

    const found = db.findByDiscordMessageId('msg-123');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(task.id);
  });

  it('should get recent tasks', () => {
    db.create({ eventId: 'e1', action: 'a', actionParams: {}, affectedService: 's1' });
    db.create({ eventId: 'e2', action: 'b', actionParams: {}, affectedService: 's2' });
    db.create({ eventId: 'e3', action: 'c', actionParams: {}, affectedService: 's3' });

    const recent = db.getRecent(2);
    expect(recent).toHaveLength(2);
  });

  it('should store and retrieve discord message ID', () => {
    const task = db.create({
      eventId: 'evt-1',
      action: 'sync_app',
      actionParams: {},
      affectedService: 'app',
      discordMessageId: 'msg-456',
    });

    const found = db.getById(task.id);
    expect(found!.discord_message_id).toBe('msg-456');
  });
});
