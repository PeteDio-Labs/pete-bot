/**
 * Tier behaviour of the merge desk's decision table (PET-645), as a matrix. decide.test.ts
 * covers each gate once at tier 0. This file runs every gate at every tier, so a gate that
 * only holds for one tier fails here.
 */
import { describe, it, expect } from 'bun:test';
import { decide, type Facts } from './decide.js';
import { effortFor, type CodexReview } from './codex.js';
import { TIER2_CANARIES } from './desk.js';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
type Tier = 0 | 1 | 2;
const TIERS: Tier[] = [0, 1, 2];

function review(verdict: CodexReview['verdict'], commitId = HEAD, at = '2026-10-16T01:00:00Z'): CodexReview {
  return { verdict, commitId, url: `https://example.test/${commitId}/${at}`, submittedAt: at };
}

function facts(tier: Tier, over: Partial<Facts> = {}, pull: Partial<Facts['pull']> = {}): Facts {
  return {
    repoFullName: 'PeteDio-Labs/petedio-workspace',
    defaultBranch: 'main',
    authors: new Set(['petedillo']),
    noCi: false,
    pull: {
      number: 7,
      title: 'change',
      draft: false,
      author: 'petedillo',
      headSha: HEAD,
      headRepo: 'PeteDio-Labs/petedio-workspace',
      baseRef: 'main',
      htmlUrl: 'https://github.com/PeteDio-Labs/petedio-workspace/pull/7',
      labels: [],
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      mergeable: true,
      mergeableState: 'clean',
      ...pull,
    },
    classification: { tier, reasons: [`path: tier ${tier}`], pathCount: 1 },
    codex: [review('no-blocking')],
    checks: { total: 2, passed: 2, pending: [], failed: [], skipped: [] },
    unresolvedThreads: 0,
    memory: {},
    ...over,
  };
}

describe('the final decision by tier', () => {
  it('merges tiers 0 and 1 and asks for tier 2, all on the same clean facts', () => {
    expect(decide(facts(0)).kind).toBe('merge');
    expect(decide(facts(1)).kind).toBe('merge');
    expect(decide(facts(2))).toMatchObject({ kind: 'ask', why: 'tier 2', sha: HEAD });
  });

  it('hands the tier-2 ask the Codex review it rests on', () => {
    const d = decide(facts(2, { codex: [review('no-blocking', OLD, '2026-10-15T00:00:00Z'), review('no-blocking')] }));
    expect(d.kind).toBe('ask');
    if (d.kind === 'ask') expect(d.review.commitId).toBe(HEAD);
  });

  it.each(TIERS)('an escalation goes to Pedro at tier %i', (tier) => {
    expect(decide(facts(tier, { codex: [review('escalate')] }))).toMatchObject({ kind: 'ask', why: 'Codex escalated it to you' });
  });

  it('names the more specific reason at tier 2 when a check was skipped', () => {
    const skipped = { total: 2, passed: 1, pending: [], failed: [], skipped: ['lint'] };
    expect(decide(facts(2, { checks: skipped }))).toMatchObject({ kind: 'ask', why: 'checks did not run: lint' });
  });

  it('names the escalation, not the tier, when Codex escalates a tier-2 PR', () => {
    expect(decide(facts(2, { codex: [review('escalate')] }))).toMatchObject({ why: 'Codex escalated it to you' });
  });
});

describe('no tier skips a gate', () => {
  const gates: [string, (t: Tier) => Facts][] = [
    ['a conflict', (t) => facts(t, {}, { mergeable: false, mergeableState: 'dirty' })],
    ['unknown mergeability', (t) => facts(t, {}, { mergeable: null })],
    ['a failing check', (t) => facts(t, { checks: { total: 2, passed: 1, pending: [], failed: ['ci'], skipped: [] } })],
    ['a pending check', (t) => facts(t, { checks: { total: 2, passed: 1, pending: ['ci'], failed: [], skipped: [] } })],
    ['an open thread', (t) => facts(t, { unresolvedThreads: 1 })],
    ['changes requested on the head', (t) => facts(t, { codex: [review('changes-requested')] })],
  ];
  for (const [name, build] of gates) {
    it.each(TIERS)(`waits on ${name} at tier %i`, (tier) => {
      expect(decide(build(tier)).kind).toBe('wait');
    });
  }

  it.each(TIERS)('a clean review of an older head never merges or asks at tier %i', (tier) => {
    expect(decide(facts(tier, { codex: [review('no-blocking', OLD)] })).kind).toBe('queue');
  });

  it.each(TIERS)('a draft is skipped at tier %i', (tier) => {
    expect(decide(facts(tier, {}, { draft: true }))).toMatchObject({ kind: 'skip', reason: 'draft' });
  });

  it.each(TIERS)('a hold label skips at tier %i', (tier) => {
    expect(decide(facts(tier, {}, { labels: ['merge-desk/hold'] })).kind).toBe('skip');
  });

  it.each(TIERS)('two blocking rounds stop the desk at tier %i', (tier) => {
    const rounds = [
      review('changes-requested', OLD, '2026-10-15T00:00:00Z'),
      review('changes-requested', 'c'.repeat(40), '2026-10-15T01:00:00Z'),
    ];
    expect(decide(facts(tier, { codex: rounds })).kind).toBe('stop');
  });
});

describe('the review effort follows the tier', () => {
  it.each([
    [0, 'low'],
    [1, 'medium'],
    [2, 'high'],
  ] as const)('queues tier %i at %s effort', (tier, effort) => {
    expect(decide(facts(tier, { codex: [] }))).toEqual({ kind: 'queue', sha: HEAD, effort });
  });

  it('treats a tier above 2 as the hardest read and a negative tier as the lightest', () => {
    expect(effortFor(3)).toBe('high');
    expect(effortFor(-1)).toBe('low');
  });
});

describe('TIER2_CANARIES', () => {
  it('lists each path once, so a duplicate cannot hide a missing canary', () => {
    expect(new Set(TIER2_CANARIES).size).toBe(TIER2_CANARIES.length);
  });

  it('holds only repository-relative paths', () => {
    for (const p of TIER2_CANARIES) {
      expect(p.startsWith('/')).toBe(false);
      expect(p.includes('..')).toBe(false);
    }
  });

  it('includes the classifier itself and the working agreement', () => {
    expect(TIER2_CANARIES).toContain('scripts/pr-blast-radius.py');
    expect(TIER2_CANARIES).toContain('Claude/working-agreement.md');
  });
});
