import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agreement, CodexGradeStore } from './codex-grades.js';

describe('agreement', () => {
  test('clean agrees with no-blocking and disagrees with the rest', () => {
    expect(agreement('clean', 'no-blocking')).toBe('agree');
    expect(agreement('clean', 'changes-requested')).toBe('disagree');
    expect(agreement('clean', 'escalate')).toBe('disagree');
  });
  test('block agrees with a blocking Codex verdict', () => {
    expect(agreement('block', 'changes-requested')).toBe('agree');
    expect(agreement('block', 'escalate')).toBe('agree');
    expect(agreement('block', 'no-blocking')).toBe('disagree');
  });
  test('a Qwen word that is not a verdict is not graded', () => {
    expect(agreement('unreadable', 'no-blocking')).toBe('ungradeable');
    expect(agreement('too-large', 'escalate')).toBe('ungradeable');
  });
});

describe('CodexGradeStore', () => {
  const row = { repo: 'r', pr: 1, sha: 'a'.repeat(40), qwen: 'clean', codex: 'changes-requested' as const, codexUrl: 'https://x' };

  test('records one grade per head and counts what it read', () => {
    const s = new CodexGradeStore(':memory:');
    expect(s.record(row)).toBe(true);
    expect(s.record(row)).toBe(false);
    expect(s.record({ ...row, pr: 2, qwen: 'block', codex: 'escalate' })).toBe(true);
    expect(s.summary()).toMatchObject({ graded: 2, agree: 1, disagree: 1, missed: 1 });
  });

  test('an ungradeable Qwen word stores nothing', () => {
    const s = new CodexGradeStore(':memory:');
    expect(s.record({ ...row, qwen: 'unreadable' })).toBe(false);
    expect(s.summary().graded).toBe(0);
  });

  test('an empty store says it graded nothing', () => {
    expect(new CodexGradeStore(':memory:').summary()).toEqual({ graded: 0, agree: 0, disagree: 0, missed: 0, since: null });
  });
});

describe('isolation (OpenAI terms)', () => {
  test('nothing that builds a Qwen prompt imports the grades', () => {
    const dir = import.meta.dir;
    const files = ['qwen.ts', 'decide.ts', 'store.ts'];
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8')).not.toMatch(/codex-grades/);
    expect(files.every((f) => readdirSync(dir).includes(f))).toBe(true);
  });
});
