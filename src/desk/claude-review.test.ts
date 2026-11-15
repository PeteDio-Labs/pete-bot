import { describe, expect, it } from 'bun:test';
import { claudeOnHead, claudeReviewOf, claudeReviews } from './claude-review.js';
import { decide, type Facts } from './decide.js';
import type { ClaudeReview } from './claude-review.js';
import type { CodexReview } from './codex.js';

const HEAD = 'a'.repeat(40);
const ALLOWED = new Set(['petedillo']);
const claude = (verdict: ClaudeReview['verdict'], sha = HEAD.slice(0, 12), author = 'petedillo', at = '2026-11-15T01:00:00Z'): ClaudeReview => ({ verdict, sha, author, url: 'https://x/c', at });
const codex = (verdict: CodexReview['verdict'], commitId = HEAD): CodexReview => ({ verdict, commitId, url: 'https://x/k', submittedAt: '2026-11-15T01:00:00Z' });

function facts(over: Partial<Facts> = {}): Facts {
  return {
    repoFullName: 'PeteDio-Labs/petedio-iac',
    defaultBranch: 'main',
    authors: new Set(['petedio-cloud-threads[bot]']),
    noCi: false,
    pull: {
      number: 7, title: 't', draft: false, author: 'petedio-cloud-threads[bot]', headSha: HEAD, headRepo: 'PeteDio-Labs/petedio-iac', baseRef: 'main',
      htmlUrl: 'https://x', labels: [], state: 'open', merged: false, mergeCommitSha: null, mergeable: true, mergeableState: 'clean',
    },
    classification: { tier: 1, reasons: [], pathCount: 1 },
    codex: [],
    claudeMode: true,
    claude: [],
    checks: { total: 2, passed: 2, pending: [], failed: [], skipped: [] },
    unresolvedThreads: 0,
    memory: {},
    ...over,
  };
}

describe('parsing the Claude review line', () => {
  const at = (body: string, author = 'petedillo') => claudeReviewOf(author, body, 'u', 't', ALLOWED);
  it('reads both verdicts, an optional heading and an upper-case SHA', () => {
    expect(at(`Claude review: No blocking findings at ${HEAD.slice(0, 12)}\nmore`)).toMatchObject({ verdict: 'no-blocking', sha: 'aaaaaaaaaaaa' });
    expect(at('## Claude review: Changes requested at ABCDEF123456')).toMatchObject({ verdict: 'changes-requested', sha: 'abcdef123456' });
  });
  it('refuses an unlisted login, a missing or short SHA, a non-first line and a free-form verdict', () => {
    expect(at('Claude review: No blocking findings at aaaaaaaaaaaa', 'someone-else')).toBeNull();
    expect(at('Claude review: No blocking findings')).toBeNull();
    expect(at('Claude review: No blocking findings at aaaaaaaaaaa')).toBeNull();
    expect(at('claude review: no blocking findings at aaaaaaaaaaaa')).toBeNull();
    expect(at('intro\nClaude review: No blocking findings at aaaaaaaaaaaa')).toBeNull();
    expect(at('Claude review: Looks fine at aaaaaaaaaaaa')).toBeNull();
  });
  it('reads reviews and comments together', () => {
    const r = { id: 1, author: 'petedillo', commitId: HEAD, state: 'COMMENTED', body: 'Claude review: No blocking findings at aaaaaaaaaaaa', htmlUrl: 'r', submittedAt: '1' };
    const c = { author: 'petedillo', body: 'chatter', htmlUrl: 'c', updatedAt: '2' };
    expect(claudeReviews([r], [c], ALLOWED)).toHaveLength(1);
  });
  it('ignores a dismissed or pending review, and dates a comment by its last edit', () => {
    const r = { id: 1, author: 'petedillo', commitId: HEAD, state: 'COMMENTED', body: 'Claude review: Changes requested at aaaaaaaaaaaa', htmlUrl: 'r', submittedAt: '1' };
    expect(claudeReviews([{ ...r, state: 'DISMISSED' }, { ...r, state: 'PENDING', submittedAt: '' }], [], ALLOWED)).toEqual([]);
    const edited = { author: 'petedillo', body: 'Claude review: No blocking findings at aaaaaaaaaaaa', htmlUrl: 'c', updatedAt: '9' };
    expect(claudeReviews([], [edited], ALLOWED)[0]!.at).toBe('9');
  });
  it('picks the newest review of exactly this head and never the PR author’s own', () => {
    const list = [claude('no-blocking', 'bbbbbbbbbbbb'), claude('changes-requested', 'aaaaaaa', 'petedillo', '1'), claude('no-blocking', 'aaaaaaa', 'petedillo', '2')];
    expect(claudeOnHead(list, HEAD, 'bot')?.verdict).toBe('no-blocking');
    expect(claudeOnHead(list, HEAD, 'PeteDillo')).toBeNull();
  });
});

describe('the decision with Claude reviews on', () => {
  it('merges tier 1 on a Claude "No blocking findings" of the head, with no Codex queued', () => {
    expect(decide(facts({ claude: [claude('no-blocking')] }))).toMatchObject({ kind: 'merge', by: 'claude', review: null });
  });
  it('waits, and queues nothing, while no Claude review names the head', () => {
    expect(decide(facts())).toEqual({ kind: 'wait', reason: 'waiting for a Claude review of the head' });
    expect(decide(facts({ claude: [claude('no-blocking', 'bbbbbbbbbbbb')] })).kind).toBe('wait');
  });
  it('holds on a Claude "Changes requested" of the head', () => {
    expect(decide(facts({ claude: [claude('changes-requested')] }))).toMatchObject({ kind: 'wait', reason: 'Claude requested changes on the head' });
  });
  it('a Claude review never merges tier 2, which still needs Codex', () => {
    const t2 = facts({ claude: [claude('no-blocking')], classification: { tier: 2, reasons: [], pathCount: 1 } });
    expect(decide(t2).kind).toBe('queue');
    expect(decide({ ...t2, codex: [codex('no-blocking')] })).toMatchObject({ kind: 'ask', why: 'tier 2' });
  });
  it('requires Codex once a second opinion was queued, whatever Claude says', () => {
    const f = facts({ claude: [claude('no-blocking')], memory: { secondOpinionAt: '2026-11-15T00:00:00Z' } });
    expect(decide(f).kind).toBe('queue');
    expect(decide({ ...f, codex: [codex('no-blocking')] })).toMatchObject({ kind: 'merge', by: 'codex' });
    expect(decide({ ...f, codex: [codex('changes-requested')] }).kind).toBe('wait');
  });
  it('treats any Codex review on the PR as a second opinion: its "Changes requested" is never walked past', () => {
    const f = facts({ claude: [claude('no-blocking')], codex: [codex('changes-requested', 'b'.repeat(40))] });
    expect(decide(f).kind).toBe('queue');
  });
  it('keeps every other gate: failing checks, conflicts, open threads', () => {
    const base = { claude: [claude('no-blocking')] };
    expect(decide(facts({ ...base, checks: { total: 2, passed: 1, pending: [], failed: ['validate'], skipped: [] } })).kind).toBe('wait');
    expect(decide(facts({ ...base, unresolvedThreads: 1 })).kind).toBe('wait');
  });
  it('changes nothing while no reviewer login is configured', () => {
    expect(decide(facts({ claudeMode: false, claude: [claude('no-blocking')] })).kind).toBe('queue');
  });
});
