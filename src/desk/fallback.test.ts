/**
 * The Codex-out fallback (PET-751): tier 0 rides on CI, tier 1 needs a clean Qwen pass,
 * tier 2 never falls back. Every case that merges has a twin that must not.
 */
import { describe, it, expect } from 'bun:test';
import { decide, type Facts, type PrMemory } from './decide.js';
import { parseVerdict, ollamaReviewer } from './qwen.js';

const HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-11-07T12:00:00Z');
const HOUR = 3_600_000;

function facts(tier: 0 | 1 | 2, memory: PrMemory, over: Partial<Facts> = {}): Facts {
  return {
    repoFullName: 'PeteDio-Labs/pete-bot',
    defaultBranch: 'main',
    authors: new Set(['petedillo']),
    noCi: false,
    pull: {
      number: 7, title: 'change', draft: false, author: 'petedillo', headSha: HEAD,
      headRepo: 'PeteDio-Labs/pete-bot', baseRef: 'main', htmlUrl: 'https://example.test/7',
      labels: [], state: 'open', merged: false, mergeCommitSha: null, mergeable: true, mergeableState: 'clean',
    },
    classification: { tier, reasons: [], pathCount: 1 },
    codex: [],
    checks: { total: 2, passed: 2, pending: [], failed: [], skipped: [] },
    unresolvedThreads: 0,
    memory,
    fallback: { enabled: true, afterMs: 2 * HOUR },
    now: NOW,
    ...over,
  };
}

const silent: PrMemory = { queuedSha: HEAD, queuedAt: new Date(NOW - 3 * HOUR).toISOString() };
const failed: PrMemory = { queuedSha: HEAD, queuedAt: new Date(NOW - 5 * 60_000).toISOString(), queueFailedSha: HEAD };

describe('Codex-out fallback', () => {
  it('waits for Codex inside the window', () => {
    const m = { queuedSha: HEAD, queuedAt: new Date(NOW - HOUR).toISOString() };
    expect(decide(facts(1, m)).kind).toBe('wait');
  });
  it('merges tier 0 on CI alone once Codex is silent past the window', () => {
    expect(decide(facts(0, silent))).toMatchObject({ kind: 'merge', by: 'ci', review: null });
  });
  it('starts Qwen for tier 1 when the Codex queue failed', () => {
    expect(decide(facts(1, failed))).toEqual({ kind: 'qwen', sha: HEAD });
  });
  it('merges tier 1 on a clean Qwen pass of this head', () => {
    const m = { ...silent, qwen: { sha: HEAD, verdict: 'clean' as const, at: new Date(NOW).toISOString() } };
    expect(decide(facts(1, m))).toMatchObject({ kind: 'merge', by: 'qwen' });
  });
  it.each(['block', 'unreadable', 'too-large'] as const)('holds tier 1 on a %s Qwen pass', (verdict) => {
    const m = { ...silent, qwen: { sha: HEAD, verdict, at: new Date(NOW).toISOString() } };
    expect(decide(facts(1, m)).kind).toBe('wait');
  });
  it('ignores a clean Qwen pass of an older head', () => {
    const m = { ...silent, qwen: { sha: 'b'.repeat(40), verdict: 'clean' as const, at: new Date(NOW).toISOString() } };
    expect(decide(facts(1, m))).toEqual({ kind: 'qwen', sha: HEAD });
  });
  it('reruns a Qwen pass stuck running after a restart, not a fresh one', () => {
    const stale = { ...silent, qwen: { sha: HEAD, verdict: 'running' as const, at: new Date(NOW - HOUR).toISOString() } };
    const fresh = { ...silent, qwen: { sha: HEAD, verdict: 'running' as const, at: new Date(NOW - 60_000).toISOString() } };
    expect(decide(facts(1, stale)).kind).toBe('qwen');
    expect(decide(facts(1, fresh)).kind).toBe('wait');
  });
  it('never falls back at tier 2', () => {
    expect(decide(facts(2, failed)).kind).toBe('wait');
    expect(decide(facts(2, silent)).kind).toBe('wait');
  });
  it('keeps every other gate under the fallback', () => {
    const m = { ...silent, qwen: { sha: HEAD, verdict: 'clean' as const, at: new Date(NOW).toISOString() } };
    expect(decide(facts(1, m, { checks: { total: 2, passed: 1, pending: [], failed: ['ci'], skipped: [] } })).kind).toBe('wait');
    expect(decide(facts(1, m, { unresolvedThreads: 1 })).kind).toBe('wait');
    expect(decide(facts(1, m, { pull: { ...facts(1, m).pull, labels: ['merge-desk/hold'] } })).kind).toBe('skip');
  });
  it('stays Codex-only when the fallback is off', () => {
    expect(decide(facts(0, silent, { fallback: { enabled: false, afterMs: 0 } })).kind).toBe('wait');
    expect(decide(facts(0, failed, { fallback: undefined })).kind).toBe('wait');
  });
});

describe('Qwen verdict', () => {
  it('reads only an exact first line', () => {
    expect(parseVerdict('VERDICT: CLEAN\nnothing found')).toBe('clean');
    expect(parseVerdict('<think>x</think>\nVERDICT: BLOCK\nsecret')).toBe('block');
    expect(parseVerdict('Looks fine. VERDICT: CLEAN')).toBe('unreadable');
    expect(parseVerdict('VERDICT: CLEAN but check')).toBe('unreadable');
    expect(parseVerdict('')).toBe('unreadable');
  });
  it('refuses a diff over the limit without calling the model', async () => {
    let called = false;
    const r = ollamaReviewer({ url: 'http://x', model: 'm', numCtx: 1, maxDiffChars: 10, timeoutMs: 1000 }, (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch);
    expect(await r.review({ title: 't', diff: 'x'.repeat(11) })).toBe('too-large');
    expect(called).toBe(false);
  });
  it('treats an Ollama error as a thrown failure, never a verdict', async () => {
    const r = ollamaReviewer({ url: 'http://x', model: 'm', numCtx: 1, maxDiffChars: 100, timeoutMs: 1000 }, (async () => new Response('no', { status: 500 })) as unknown as typeof fetch);
    await expect(r.review({ title: 't', diff: 'x' })).rejects.toThrow('500');
  });
});
