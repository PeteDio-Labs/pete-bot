/**
 * The merge desk end to end, against a fake GitHub (PET-645): what it merges, what it asks,
 * what it says once, and what a tap can and cannot do.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { MergeDesk, buttonId, parseButtonId, type Button } from './desk.js';
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
    return { total: 1, passed: 1, pending: [], failed: [] };
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
    this.approvals.push(sha);
  }
  async merge(_r: string, _n: number, sha: string) {
    this.merges.push(sha);
    return this.mergeResult;
  }
  async onBranch() {
    return true;
  }
  async comment(_r: string, _n: number, body: string) {
    this.comments.push(body);
  }
}

// Grades by path the way the real rules do for these fixtures: .tf is tier 2, the rest 0.
const runPython = async (argv: string[]) => {
  const list = await Bun.file(argv[argv.indexOf('--paths-from') + 1]!).text();
  const paths = list.split('\n').filter(Boolean);
  const rows = paths.map((p) => ({ path: p, tier: p.endsWith('.tf') ? 2 : 0, reason: 'fixture' }));
  return { exitCode: 0, stdout: JSON.stringify({ tier: Math.max(...rows.map((r) => r.tier)), floor_note: null, paths: rows }), stderr: '' };
};

let gh: FakeGitHub;
let dms: { content: string; buttons?: Button[] }[];
let queued: string[];
let queueOk: boolean;

function makeDesk(over: Partial<DeskSettings> = {}) {
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
    store: new DeskStore(':memory:'),
    notifier: { dm: async (content, buttons) => void dms.push({ content, buttons }) },
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
