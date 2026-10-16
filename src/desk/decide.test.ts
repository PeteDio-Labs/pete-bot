/**
 * The merge desk's decision table (PET-645). Every gate is tested by the case that would
 * merge if the gate were missing.
 */
import { describe, it, expect } from 'bun:test';
import { decide, blockingRounds, HOLD_LABEL, type Facts } from './decide.js';
import type { CodexReview } from './codex.js';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

function review(verdict: CodexReview['verdict'], commitId = HEAD, at = '2026-10-16T01:00:00Z'): CodexReview {
  return { verdict, commitId, url: `https://example.test/${commitId}/${at}`, submittedAt: at };
}

function facts(over: Partial<Facts> = {}, pull: Partial<Facts['pull']> = {}): Facts {
  return {
    repoFullName: 'PeteDio-Labs/petedio-workspace',
    defaultBranch: 'main',
    authors: new Set(['petedillo']),
    pull: {
      number: 7,
      title: 'docs',
      draft: false,
      author: 'petedillo',
      headSha: HEAD,
      headRepo: 'PeteDio-Labs/petedio-workspace',
      baseRef: 'main',
      htmlUrl: 'https://github.com/PeteDio-Labs/petedio-workspace/pull/7',
      labels: [],
      state: 'open',
      merged: false,
      mergeable: true,
      mergeableState: 'clean',
      ...pull,
    },
    classification: { tier: 0, reasons: ['README.md: prose'], pathCount: 1 },
    codex: [review('no-blocking')],
    checks: { total: 2, passed: 2, pending: [], failed: [] },
    unresolvedThreads: 0,
    memory: {},
    ...over,
  };
}

describe('what the desk merges on its own', () => {
  it('merges a tier-0 PR with a clean Codex review of the head', () => {
    expect(decide(facts())).toMatchObject({ kind: 'merge', sha: HEAD });
  });

  it('merges tier 1 the same way', () => {
    expect(decide(facts({ classification: { tier: 1, reasons: [], pathCount: 1 } })).kind).toBe('merge');
  });

  it('merges with zero checks, because the report names the count', () => {
    expect(decide(facts({ checks: { total: 0, passed: 0, pending: [], failed: [] } })).kind).toBe('merge');
  });
});

describe('what goes to Pedro', () => {
  it('asks for a tap on tier 2', () => {
    expect(decide(facts({ classification: { tier: 2, reasons: [], pathCount: 1 } }))).toMatchObject({ kind: 'ask', why: 'tier 2' });
  });

  it('asks for a tap when Codex escalates, whatever the tier', () => {
    expect(decide(facts({ codex: [review('escalate')] }))).toMatchObject({ kind: 'ask', why: 'Codex escalated it to you' });
  });
});

describe('skips', () => {
  it.each([
    ['a draft', facts({}, { draft: true }), 'draft'],
    ['a fork', facts({}, { headRepo: 'someone/petedio-workspace' }), 'from a fork'],
    ['a stranger', facts({}, { author: 'mallory' }), 'author mallory is not on DESK_AUTHORS'],
    ['another base', facts({}, { baseRef: 'release' }), 'targets release, not main'],
    ['a held PR', facts({}, { labels: [HOLD_LABEL] }), `labelled ${HOLD_LABEL}`],
    ['a closed PR', facts({}, { state: 'closed' }), 'not open'],
  ])('skips %s', (_name, f, reason) => {
    expect(decide(f)).toEqual({ kind: 'skip', reason });
  });

  it('matches authors without regard to case', () => {
    expect(decide(facts({}, { author: 'PeteDillo' })).kind).toBe('merge');
  });
});

describe('Codex', () => {
  it('queues a review when none is of the head, at the tier effort', () => {
    expect(decide(facts({ codex: [review('no-blocking', OLD)] }))).toEqual({ kind: 'queue', sha: HEAD, effort: 'low' });
    expect(
      decide(facts({ codex: [], classification: { tier: 2, reasons: [], pathCount: 1 } })),
    ).toEqual({ kind: 'queue', sha: HEAD, effort: 'high' });
  });

  it('never counts a clean review of an older head', () => {
    expect(decide(facts({ codex: [review('no-blocking', OLD)] })).kind).toBe('queue');
  });

  it('queues a head once', () => {
    expect(decide(facts({ codex: [], memory: { queuedSha: HEAD, queueRunning: true } })).kind).toBe('wait');
    expect(decide(facts({ codex: [], memory: { queuedSha: HEAD, queueFailedSha: HEAD } }))).toEqual({
      kind: 'wait',
      reason: 'queueing Codex failed for this head',
    });
  });

  it('waits on changes requested', () => {
    expect(decide(facts({ codex: [review('changes-requested')] }))).toEqual({ kind: 'wait', reason: 'Codex requested changes on the head' });
  });

  it('reads the newest verdict on the head', () => {
    const codex = [review('changes-requested', HEAD, '2026-10-16T01:00:00Z'), review('no-blocking', HEAD, '2026-10-16T02:00:00Z')];
    expect(decide(facts({ codex })).kind).toBe('merge');
  });

  it('stops after two blocking rounds instead of queueing a third', () => {
    const codex = [review('changes-requested', OLD, '2026-10-16T01:00:00Z'), review('changes-requested', 'c'.repeat(40), '2026-10-16T02:00:00Z')];
    expect(decide(facts({ codex }))).toMatchObject({ kind: 'stop', sha: HEAD });
    expect(decide(facts({ codex, memory: { extraRounds: 1 } })).kind).toBe('queue');
  });

  it('counts a commit blocked twice as one round', () => {
    const codex = [review('changes-requested', OLD, '2026-10-16T01:00:00Z'), review('changes-requested', OLD, '2026-10-16T02:00:00Z')];
    expect(blockingRounds(codex)).toHaveLength(1);
  });
});

describe('the merge gates', () => {
  it.each([
    ['mergeability unknown', facts({}, { mergeable: null })],
    ['a conflict', facts({}, { mergeable: false, mergeableState: 'dirty' })],
    ['a failing check', facts({ checks: { total: 2, passed: 1, pending: [], failed: ['ci (failure)'] } })],
    ['a pending check', facts({ checks: { total: 2, passed: 1, pending: ['ci'], failed: [] } })],
    ['an open thread', facts({ unresolvedThreads: 1 })],
  ])('waits on %s', (_name, f) => {
    expect(decide(f).kind).toBe('wait');
  });

  it('holds a tier-2 PR on the same gates before it asks', () => {
    expect(decide(facts({ classification: { tier: 2, reasons: [], pathCount: 1 }, unresolvedThreads: 2 })).kind).toBe('wait');
  });
});
