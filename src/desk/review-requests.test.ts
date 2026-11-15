import { describe, expect, it } from 'bun:test';
import { CodexReviewRequests } from './review-requests.js';
import { CODEX_LOGIN } from './codex.js';
import type { QueueResult } from './codex.js';

const log = { info() {}, warn() {}, error() {} };
const review = (commitId: string, first = '## Codex review: No blocking findings') => ({
  id: 1, author: CODEX_LOGIN, commitId, state: 'COMMENTED', body: `${first}\nbody`, htmlUrl: 'https://x/r/1', submittedAt: '2026-11-15T00:00:00Z',
});

function setup(opts: { onQueued?: (repo: string, pr: number, sha: string) => void; open?: boolean; head?: string; reviews?: ReturnType<typeof review>[]; result?: QueueResult; afterRun?: () => void } = {}) {
  let head = opts.head ?? 'aaaaaaa1';
  const reviews = [...(opts.reviews ?? [])];
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const queue = {
    enqueue: async (repo: string, n: number, effort: string): Promise<QueueResult> => {
      calls.push(`${repo} ${n} ${effort}`);
      await gate;
      opts.afterRun?.();
      return opts.result ?? { ok: true, exitCode: 0, tail: '' };
    },
  };
  const github = {
    getPull: async () => ({ state: opts.open === false ? 'closed' : 'open', merged: false, headSha: head }) as never,
    listReviews: async () => reviews as never,
  };
  const reqs = new CodexReviewRequests({ queue, github, repos: ['petedio-iac', 'pete-bot'], log, onQueued: opts.onQueued });
  return { reqs, calls, release, reviews, setHead: (h: string) => (head = h) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('request', () => {
  it('refuses a repository that is not on the desk list, before it reads GitHub', async () => {
    const { reqs, calls } = setup();
    expect(await reqs.request('petedio-usaa', 1)).toEqual({ kind: 'refused', reason: expect.stringContaining('not on the desk') });
    expect(calls).toEqual([]);
  });

  it('refuses a PR that is not open', async () => {
    const { reqs } = setup({ open: false });
    expect((await reqs.request('petedio-iac', 5)).kind).toBe('refused');
  });

  it('returns the existing verdict when the head already has a Codex review', async () => {
    const { reqs, calls } = setup({ reviews: [review('aaaaaaa1', '## Codex review: Changes requested')] });
    const out = await reqs.request('petedio-iac', 5);
    expect(out.kind).toBe('already-reviewed');
    expect(out.kind === 'already-reviewed' && out.review.verdict).toBe('changes-requested');
    expect(calls).toEqual([]);
  });

  it('queues once per head, and says so for a repeat', async () => {
    const { reqs, calls, release } = setup();
    expect((await reqs.request('petedio-iac', 5, 'high')).kind).toBe('queued');
    expect((await reqs.request('petedio-iac', 5)).kind).toBe('already-queued');
    release();
    await settle();
    expect(calls).toEqual(['petedio-iac 5 high']);
  });
});

describe('the second-opinion mark', () => {
  it('is saved once, before the queue call, and not for a refused or already-reviewed request', async () => {
    const marks: string[] = [];
    const s = setup({ onQueued: (r, n, sha) => marks.push(`${r}#${n}@${sha}`) });
    await s.reqs.request('petedio-usaa', 5);
    expect(marks).toEqual([]);
    await s.reqs.request('petedio-iac', 5);
    expect(marks).toEqual(['petedio-iac#5@aaaaaaa1']);
    const done = setup({ reviews: [review('aaaaaaa1')], onQueued: (r) => marks.push(r) });
    await done.reqs.request('petedio-iac', 6);
    expect(marks).toHaveLength(1);
  });
});

describe('concurrency', () => {
  it('queues one review when two requests for the same head arrive together', async () => {
    const { reqs, calls, release } = setup();
    const [a, b] = await Promise.all([reqs.request('petedio-iac', 5), reqs.request('petedio-iac', 5)]);
    expect([a.kind, b.kind].sort()).toEqual(['already-queued', 'queued']);
    release();
    await settle();
    expect(calls).toHaveLength(1);
  });
});

describe('result', () => {
  it('is done only when a Codex review of the head appeared', async () => {
    const s = setup();
    await s.reqs.request('petedio-iac', 5);
    s.reviews.push(review('aaaaaaa1'));
    s.release();
    await settle();
    const st = await s.reqs.status('petedio-iac', 5);
    expect(st.request).toMatchObject({ state: 'done', detail: 'no-blocking' });
    expect(st.reviews[0]).toMatchObject({ onHead: true });
  });

  it('is failed when the gate exits 0 and no review appeared', async () => {
    const s = setup();
    await s.reqs.request('petedio-iac', 5);
    s.release();
    await settle();
    expect((await s.reqs.status('petedio-iac', 5)).request).toMatchObject({ state: 'failed', detail: expect.stringContaining('no Codex review') });
  });

  it('says the head moved when a push landed during the run', async () => {
    const s = setup();
    await s.reqs.request('petedio-iac', 5);
    s.setHead('bbbbbbb2');
    s.release();
    await settle();
    expect((await s.reqs.status('petedio-iac', 5)).request?.detail).toContain('head moved');
  });

  it('reports a quota refusal as rate_limited, apart from other failures', async () => {
    const quota = setup({ result: { ok: false, exitCode: 3, tail: 'error: rate_limit_reached, try later' } });
    await quota.reqs.request('petedio-iac', 5);
    quota.release();
    await settle();
    expect((await quota.reqs.status('petedio-iac', 5)).request).toMatchObject({ state: 'rate_limited' });

    const other = setup({ result: { ok: false, exitCode: 255, tail: 'ssh: connect refused' } });
    await other.reqs.request('petedio-iac', 5);
    other.release();
    await settle();
    expect((await other.reqs.status('petedio-iac', 5)).request).toMatchObject({ state: 'failed' });
  });

  it('allows a new request after a failure', async () => {
    const s = setup({ result: { ok: false, exitCode: 1, tail: 'x' } });
    await s.reqs.request('petedio-iac', 5);
    s.release();
    await settle();
    expect((await s.reqs.request('petedio-iac', 5)).kind).toBe('queued');
  });
});
