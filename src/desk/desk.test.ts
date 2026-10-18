/**
 * The merge desk end to end, against a fake GitHub (PET-645): what it merges, what it asks,
 * what it says once, and what a tap can and cannot do.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { MergeDesk, buttonId, parseButtonId, TIER2_CANARIES, type Button } from './desk.js';
import { DeskStore } from './store.js';
import { CodexQueue } from './codex.js';
import type { DeskSettings } from './config.js';
import type { GitHubApp, PullDetail, Review } from './github.js';

const HEAD = 'a'.repeat(40);
const NEXT = 'c'.repeat(40);
const MERGED = 'm'.repeat(40);
const REPO = 'petedio-workspace';

const settings = (over: Partial<DeskSettings> = {}): DeskSettings => ({
  mode: 'on',
  org: 'PeteDio-Labs',
  repos: [REPO],
  authors: new Set(['petedillo']),
  noCiRepos: new Set(),
  appId: '1',
  installationId: '2',
  privateKeyPem: '',
  pollMs: 60_000,
  statePath: ':memory:',
  classifierRepo: 'petedio-iac',
  classifierPath: 'scripts/pr-blast-radius.py',
  python: 'python3',
  codex: { target: 'codex@h', keyPath: 'k', knownHostsPath: 'kh', timeoutMs: 1000 },
  ...over,
});

const codexReview = (verdict: string, commit = HEAD, at = '2026-10-16T01:00:00Z'): Review => ({
  id: Math.random(),
  author: 'petedio-codex-review[bot]',
  commitId: commit,
  state: 'COMMENTED',
  body: `## Codex review: ${verdict}\n\nbody`,
  htmlUrl: `https://github.com/r/${commit.slice(0, 3)}/${at}`,
  submittedAt: at,
});

class FakeGitHub {
  pull: PullDetail = {
    number: 5,
    title: 'Docs: tidy',
    draft: false,
    author: 'petedillo',
    headSha: HEAD,
    headRepo: `PeteDio-Labs/${REPO}`,
    baseRef: 'main',
    htmlUrl: `https://github.com/PeteDio-Labs/${REPO}/pull/5`,
    labels: [],
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    mergeable: true,
    mergeableState: 'clean',
  };
  files = [{ path: 'README.md' }];
  reviews: Review[] = [codexReview('No blocking findings')];
  threads = 0;
  mergeResult: { ok: true; sha: string } | { ok: false; status: number; message: string } = { ok: true, sha: MERGED };
  comments: string[] = [];
  approvals: string[] = [];
  merges: string[] = [];
  approveError: Error | null = null;
  mergeError: Error | null = null;
  commentFailures = 0;

  async listOpenPulls() {
    return this.pull.state === 'open' ? [this.pull] : [];
  }
  async getPull() {
    return { ...this.pull };
  }
  async listFiles() {
    return this.files;
  }
  async listReviews() {
    return this.reviews;
  }
  async checks() {
    return { total: 1, passed: 1, pending: [], failed: [], skipped: [] };
  }
  async unresolvedThreads() {
    return this.threads;
  }
  async defaultBranch() {
    return 'main';
  }
  async fileText() {
    return 'stub';
  }
  async listDir() {
    return [];
  }
  async approve(_r: string, _n: number, sha: string) {
    if (this.approveError) throw this.approveError;
    this.approvals.push(sha);
  }
  async merge(_r: string, _n: number, sha: string) {
    this.merges.push(sha);
    if (this.mergeError) throw this.mergeError;
    return this.mergeResult;
  }
  async onBranch() {
    return true;
  }
  async comment(_r: string, _n: number, body: string) {
    if (this.commentFailures > 0) {
      this.commentFailures--;
      throw new Error('HTTP 502');
    }
    this.comments.push(body);
  }
}

// Grades by path the way the real rules do for these fixtures: .tf and the canaries are
// tier 2, the rest 0. Clearing `rulesGuardDesk` plays a main that lacks the desk's rules.
let rulesGuardDesk = true;
const runPython = async (argv: string[]) => {
  const list = await Bun.file(argv[argv.indexOf('--paths-from') + 1]!).text();
  const paths = list.split('\n').filter(Boolean);
  const two = (p: string) => p.endsWith('.tf') || (rulesGuardDesk && TIER2_CANARIES.includes(p));
  const rows = paths.map((p) => ({ path: p, tier: two(p) ? 2 : 0, reason: 'fixture' }));
  return { exitCode: 0, stdout: JSON.stringify({ tier: Math.max(...rows.map((r) => r.tier)), floor_note: null, paths: rows }), stderr: '' };
};

let gh: FakeGitHub;
let dms: { content: string; buttons?: Button[] }[];
let queued: string[];
let queueOk: boolean;
let dmFailures: number;

function makeDesk(over: Partial<DeskSettings> = {}, store = new DeskStore(':memory:')) {
  const codex = new CodexQueue({
    ...settings().codex,
    spawn: async (argv) => {
      queued.push(argv.at(-1)!);
      return queueOk ? { exitCode: 0, output: '' } : { exitCode: 255, output: 'ssh: no route to host' };
    },
  });
  return new MergeDesk({
    settings: settings(over),
    github: gh as unknown as GitHubApp,
    codex,
    store,
    notifier: {
      dm: async (content, buttons) => {
        if (dmFailures > 0) {
          dmFailures--;
          throw new Error('Discord is down');
        }
        dms.push({ content, buttons });
      },
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    runPython,
  });
}

async function settle(desk: MergeDesk) {
  while (desk.inflight.size) await Promise.all([...desk.inflight]);
}

beforeEach(() => {
  gh = new FakeGitHub();
  dms = [];
  queued = [];
  queueOk = true;
  rulesGuardDesk = true;
  dmFailures = 0;
});

describe('tiers 0 and 1', () => {
  it('approves and merges the reviewed head, then reports once on the PR and in a DM', async () => {
    const desk = makeDesk();
    await desk.poll();
    expect(gh.approvals).toEqual([HEAD]);
    expect(gh.merges).toEqual([HEAD]);
    expect(gh.comments.at(-1)).toContain('merged as `mmmmmmm` on `main`');
    expect(dms).toHaveLength(1);
    expect(desk.status()).toMatchObject({ merged: 1, lastPollPrs: 1, lastPollError: null });
  });

  it('merges nothing in dry-run, and says what it would have merged once', async () => {
    const desk = makeDesk({ mode: 'dry-run' });
    await desk.poll();
    await desk.poll();
    expect(gh.merges).toEqual([]);
    expect(gh.approvals).toEqual([]);
    expect(dms).toHaveLength(1);
    expect(dms[0]!.content).toContain('would merge');
  });

  it('reports a refused merge once, then waits for a tap', async () => {
    gh.mergeResult = { ok: false, status: 405, message: 'Required status check is expected' };
    const desk = makeDesk();
    await desk.poll();
    await desk.poll();
    await desk.poll();
    expect(gh.merges).toEqual([HEAD]);
    expect(gh.comments.filter((c) => c.includes('failed'))).toHaveLength(1);
    expect(dms.filter((d) => d.buttons?.length)).toHaveLength(1);
  });
});

describe('tier 2', () => {
  it('asks for a tap once per head, and the tap merges that head', async () => {
    gh.files = [{ path: 'environments/homelab/a.tf' }];
    const desk = makeDesk();
    await desk.poll();
    await desk.poll();
    expect(gh.merges).toEqual([]);
    expect(dms).toHaveLength(1);
    const id = dms[0]!.buttons![0]!.customId;
    expect(id).toBe(buttonId('merge', REPO, 5, HEAD));
    expect(await desk.tap(id)).toContain('Merged as mmmmmmm');
    expect(gh.merges).toEqual([HEAD]);
  });

  it('refuses a tap after the head moved', async () => {
    gh.files = [{ path: 'environments/homelab/a.tf' }];
    const desk = makeDesk();
    await desk.poll();
    gh.pull.headSha = NEXT;
    expect(await desk.tap(buttonId('merge', REPO, 5, HEAD))).toContain('the head moved');
    expect(gh.merges).toEqual([]);
  });

  it('refuses a tap when a gate closed since the DM', async () => {
    gh.files = [{ path: 'environments/homelab/a.tf' }];
    const desk = makeDesk();
    await desk.poll();
    gh.threads = 1;
    expect(await desk.tap(buttonId('merge', REPO, 5, HEAD))).toBe('Not merged: 1 unresolved review thread.');
    expect(gh.merges).toEqual([]);
  });

  it('refuses a tap for a repository it does not watch, or a forged id', async () => {
    const desk = makeDesk();
    expect(await desk.tap(buttonId('merge', 'petedio-iac', 5, HEAD))).toContain('not on DESK_REPOS');
    expect(await desk.tap('desk:merge:x:1:short')).toContain('not one the merge desk sent');
  });
});

describe('Codex', () => {
  it('queues the head once, then merges when the review appears', async () => {
    gh.reviews = [];
    const desk = makeDesk();
    await desk.poll();
    // The fake queue "runs" Codex; make its review appear before the desk checks.
    gh.reviews = [codexReview('No blocking findings')];
    await settle(desk);
    await desk.poll();
    expect(queued).toEqual([`codex-review ${REPO} 5 low`]);
    expect(gh.merges).toEqual([HEAD]);
  });

  it('reports a failed queue once and merges nothing', async () => {
    gh.reviews = [];
    queueOk = false;
    const desk = makeDesk();
    await desk.poll();
    await settle(desk);
    await desk.poll();
    await desk.poll();
    expect(queued).toHaveLength(1);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toContain('exit 255');
    expect(gh.merges).toEqual([]);
  });

  it('treats a run that exits 0 with no review as a failure', async () => {
    gh.reviews = [];
    const desk = makeDesk();
    await desk.poll();
    await settle(desk);
    expect(gh.comments[0]).toContain('no Codex review of aaaaaaa appeared');
  });

  it('stops after two blocking rounds, says so once, and Review again grants one more', async () => {
    gh.reviews = [
      codexReview('Changes requested', 'b'.repeat(40), '2026-10-16T01:00:00Z'),
      codexReview('Changes requested', 'd'.repeat(40), '2026-10-16T02:00:00Z'),
    ];
    const desk = makeDesk();
    await desk.poll();
    await desk.poll();
    expect(queued).toEqual([]);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toContain('stopped after 2 blocking Codex rounds');
    const again = dms[0]!.buttons![0]!.customId;
    expect(parseButtonId(again)?.action).toBe('again');
    expect(await desk.tap(again)).toBe('Queued one more Codex round.');
    await settle(desk);
    expect(queued).toHaveLength(1);
  });
});

describe('review fixes (Codex round 1)', () => {
  it('treats every PR as tier 2 while the rules on main do not guard the desk', async () => {
    rulesGuardDesk = false;
    const desk = makeDesk();
    await desk.poll();
    expect(gh.merges).toEqual([]);
    expect(dms).toHaveLength(1);
    expect(dms[0]!.content).toContain('tier 2');
    expect(dms[0]!.content).toContain('grade scripts/pr-blast-radius.py tier 0');
  });

  it('queues the blocked head again on Review again, without waiting for a push', async () => {
    gh.reviews = [
      codexReview('Changes requested', 'b'.repeat(40), '2026-01-01T01:00:00Z'),
      codexReview('Changes requested', HEAD, '2026-01-01T02:00:00Z'),
    ];
    const desk = makeDesk();
    await desk.poll();
    expect(gh.comments[0]).toContain('stopped after 2 blocking Codex rounds');
    expect(await desk.tap(dms[0]!.buttons![0]!.customId)).toBe('Queued one more Codex round.');
    await settle(desk);
    expect(queued).toEqual([`codex-review ${REPO} 5 low`]);
  });

  it('reports a queue the last process left running, and Review again queues it', async () => {
    gh.reviews = [];
    const store = new DeskStore(':memory:');
    store.update(REPO, 5, { queuedSha: HEAD, queueRunning: true });
    const desk = makeDesk({}, store);
    await desk.recoverOrphans();
    expect(gh.comments[0]).toContain('pete-bot restarted while it ran');
    const again = dms[0]!.buttons![0]!.customId;
    expect(parseButtonId(again)?.action).toBe('again');
    await desk.poll();
    expect(queued).toEqual([]);
    expect(await desk.tap(again)).toBe('Queued one more Codex round.');
    await settle(desk);
    expect(queued).toHaveLength(1);
  });

  it('reports a thrown approval once, then waits for a tap', async () => {
    gh.approveError = new Error('HTTP 422 reading approval');
    const desk = makeDesk();
    await desk.poll();
    await desk.poll();
    await desk.poll();
    expect(gh.merges).toEqual([]);
    expect(gh.comments.filter((c) => c.includes('approval was refused'))).toHaveLength(1);
    expect(dms.filter((d) => d.buttons?.length)).toHaveLength(1);
  });

  it('reads the PR back when the merge request throws, and counts a merge that landed', async () => {
    gh.mergeError = new Error('timed out');
    gh.getPull = async () => (gh.merges.length ? { ...gh.pull, state: 'closed', merged: true, mergeCommitSha: MERGED } : { ...gh.pull });
    const desk = makeDesk();
    await desk.poll();
    expect(gh.comments.at(-1)).toContain('merged as `mmmmmmm`');
    expect(desk.status().merged).toBe(1);
  });

  it('calls a thrown merge failed when the PR did not merge', async () => {
    gh.mergeError = new Error('timed out');
    const desk = makeDesk();
    await desk.poll();
    expect(gh.comments.at(-1)).toContain('the PR is not merged');
    expect(desk.status().merged).toBe(0);
  });

  it('retries a merge report that failed, after the PR closed, without merging again', async () => {
    gh.commentFailures = 1;
    const desk = makeDesk();
    await desk.poll();
    expect(gh.merges).toEqual([HEAD]);
    expect(gh.comments).toEqual([]);
    gh.pull.state = 'closed';
    gh.pull.merged = true;
    await desk.poll();
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]).toContain('merged as `mmmmmmm`');
    expect(dms).toHaveLength(1);
    await desk.poll();
    expect(gh.comments).toHaveLength(1);
    expect(gh.merges).toEqual([HEAD]);
  });
});

describe('review fixes (Codex round 2)', () => {
  it("leaves a newer head's queue alone when an older head's job finishes", async () => {
    gh.reviews = [];
    const store = new DeskStore(':memory:');
    const desk = makeDesk({}, store);
    await desk.poll();
    // A push queued the next head while the first job still ran.
    store.update(REPO, 5, { queuedSha: NEXT, queueRunning: true });
    await settle(desk);
    expect(store.get(REPO, 5)).toMatchObject({ queuedSha: NEXT, queueRunning: true });
    expect(gh.comments).toEqual([]);
    // So a restart now reports the newer head's job instead of waiting on it forever.
    await makeDesk({}, store).recoverOrphans();
    expect(gh.comments[0]).toContain('`ccccccc` failed (pete-bot restarted while it ran)');
  });

  it('calls a re-review that posts nothing a failure, even with an old verdict on the head', async () => {
    gh.reviews = [
      codexReview('Changes requested', 'b'.repeat(40), '2026-01-01T01:00:00Z'),
      codexReview('Changes requested', HEAD, '2026-01-01T02:00:00Z'),
    ];
    const desk = makeDesk();
    await desk.poll();
    expect(await desk.tap(dms[0]!.buttons![0]!.customId)).toBe('Queued one more Codex round.');
    await settle(desk);
    expect(gh.comments.at(-1)).toContain('no Codex review of aaaaaaa appeared');
  });

  it('keeps a failed queue report, button and all, until the DM lands', async () => {
    gh.reviews = [];
    queueOk = false;
    dmFailures = 1;
    const desk = makeDesk();
    await desk.poll();
    await settle(desk);
    expect(gh.comments).toHaveLength(1);
    expect(dms).toEqual([]);
    await desk.poll();
    expect(dms).toHaveLength(1);
    expect(parseButtonId(dms[0]!.buttons![0]!.customId)?.action).toBe('again');
    await desk.poll();
    expect(dms).toHaveLength(1);
    expect(gh.comments).toHaveLength(1);
  });

  it('retries a failed-merge comment on the next poll', async () => {
    gh.mergeResult = { ok: false, status: 405, message: 'Required status check is expected' };
    gh.commentFailures = 1;
    const desk = makeDesk();
    await desk.poll();
    expect(gh.comments).toEqual([]);
    await desk.poll();
    expect(gh.comments.filter((c) => c.includes('failed: HTTP 405'))).toHaveLength(1);
  });
});
