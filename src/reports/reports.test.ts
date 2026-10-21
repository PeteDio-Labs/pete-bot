import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReportSettings, type ReportSettings } from './settings.js';
import { dueReports, localTime } from './schedule.js';
import { PlaneClient } from './plane.js';
import { collectRepo, petKeys, type GithubReads, type OpenPr, type RepoRead } from './collect.js';
import { buildMorning, actionFor } from './morning.js';
import { buildAudit } from './audit.js';
import { buildSweep, mergedOverCodex } from './sweep.js';
import { ReportRunner, chunk } from './runner.js';
import type { Snapshot } from './snapshot.js';
import type { PlaneItem, PlaneRead } from './plane.js';
import type { ClosedPr } from './collect.js';

const PEM = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
const env = {
  REPORTS_MODE: 'on',
  REPORT_REPOS: 'petedio-iac,pete-bot',
  DESK_APP_ID: '123',
  DESK_INSTALLATION_ID: '456',
  DESK_APP_KEY_PATH: '/k.pem',
  REPORT_STATE_PATH: '/tmp/x.json',
};
const readKey = () => PEM;

describe('loadReportSettings', () => {
  it('is off when REPORTS_MODE is empty', () => {
    expect(loadReportSettings({}, readKey).state).toBe('off');
  });
  it('refuses to run without a state path, so a restart cannot repeat or lose a report', () => {
    const s = loadReportSettings({ ...env, REPORT_STATE_PATH: '' }, readKey);
    expect(s).toMatchObject({ state: 'misconfigured' });
  });
  it('refuses an unknown report name and an unreadable key', () => {
    expect(loadReportSettings({ ...env, REPORTS_ENABLED: 'morning,nightly' }, readKey).state).toBe('misconfigured');
    expect(loadReportSettings(env, () => { throw new Error('ENOENT'); }).state).toBe('misconfigured');
  });
  it('leaves Plane null without a key and fills the defaults with one', () => {
    const a = loadReportSettings(env, readKey);
    expect(a.state === 'ready' && a.settings.plane).toBeNull();
    const b = loadReportSettings({ ...env, PLANE_API_KEY: 'k' }, readKey);
    expect(b.state === 'ready' && b.settings.plane?.workspace).toBe('petedio');
  });
});

describe('schedule', () => {
  const all = new Set(['morning', 'audit', 'sweep'] as const);
  it('computes Eastern time across daylight saving', () => {
    expect(localTime(new Date('2026-10-20T11:52:00Z'))).toMatchObject({ date: '2026-10-20', weekday: 2, minutes: 7 * 60 + 52 });
    expect(localTime(new Date('2026-12-01T12:52:00Z')).minutes).toBe(7 * 60 + 52);
  });
  it('sends the morning queue on a weekday from 07:52 and not before', () => {
    expect(dueReports(new Date('2026-10-20T11:51:00Z'), {}, all, false)).toEqual([]);
    expect(dueReports(new Date('2026-10-20T11:52:00Z'), {}, all, false)).toEqual(['morning']);
  });
  it('catches up inside the grace window and gives up after it', () => {
    expect(dueReports(new Date('2026-10-20T13:30:00Z'), {}, all, false)).toEqual(['morning']);
    expect(dueReports(new Date('2026-10-20T15:00:00Z'), {}, all, false)).toEqual([]);
  });
  it('sends once per local date', () => {
    expect(dueReports(new Date('2026-10-20T11:53:00Z'), { morning: '2026-10-20' }, all, false)).toEqual([]);
  });
  it('skips the morning queue on a weekend and runs the audit on Monday only', () => {
    expect(dueReports(new Date('2026-10-24T12:00:00Z'), {}, all, false)).toEqual([]);
    expect(dueReports(new Date('2026-10-26T12:50:00Z'), {}, all, false).sort()).toEqual(['audit', 'morning']);
    expect(dueReports(new Date('2026-10-21T12:50:00Z'), {}, all, false)).toEqual(['morning']);
  });
  it('runs the sweep daily, or Mondays when weekly', () => {
    expect(dueReports(new Date('2026-10-21T22:50:00Z'), {}, all, false)).toEqual(['sweep']);
    expect(dueReports(new Date('2026-10-21T22:50:00Z'), {}, all, true)).toEqual([]);
    expect(dueReports(new Date('2026-10-26T22:50:00Z'), {}, all, true)).toEqual(['sweep']);
  });
});

function planeFetch(pages: unknown[]): typeof fetch {
  let i = 0;
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('/states/')) return Response.json({ results: [{ id: 's1', name: 'In Review', group: 'started' }, { id: 's2', name: 'Done', group: 'completed' }] });
    if (u.includes('/labels/')) return Response.json({ results: [{ id: 'l1', name: 'cloud' }] });
    return Response.json(pages[Math.min(i++, pages.length - 1)]);
  }) as typeof fetch;
}
const rawItem = (n: number, extra = {}) => ({ id: `i${n}`, sequence_id: n, name: `Item ${n}`, state: 's1', labels: ['l1'], parent: 'p', updated_at: '2026-10-19T00:00:00Z', ...extra });
const plane = { baseUrl: 'http://plane', workspace: 'w', projectId: 'p', apiKey: 'k' };

describe('PlaneClient', () => {
  it('follows the cursor and resolves state and label names', async () => {
    const c = new PlaneClient(plane, planeFetch([
      { results: [rawItem(1)], next_page_results: true, next_cursor: 'c2', total_count: 2 },
      { results: [rawItem(2)], next_page_results: false, total_count: 2 },
    ]));
    const r = await c.read();
    expect(r.ok && r.items.map((i) => [i.seq, i.stateName, i.labels])).toEqual([[1, 'In Review', ['cloud']], [2, 'In Review', ['cloud']]]);
  });
  it('refuses a partial list', async () => {
    const c = new PlaneClient(plane, planeFetch([{ results: [rawItem(1)], next_page_results: false, total_count: 5 }]));
    const r = await c.read();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('partial');
  });
  it('treats an empty board and an HTTP error as failures, not as a clean board', async () => {
    expect((await new PlaneClient(plane, planeFetch([{ results: [], next_page_results: false }])).read()).ok).toBe(false);
    const down = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch;
    const r = await new PlaneClient(plane, down).read();
    expect(!r.ok && r.error).toContain('502');
  });
});

describe('petKeys', () => {
  it('reads titles and branch names', () => {
    expect(petKeys('PET-701: add reports (#3)', 'pet-701-routines')).toEqual([701]);
    expect(petKeys('no key here', 'claude/project-thread-x')).toEqual([]);
  });
});

function fakeGh(over: Partial<GithubReads> & { open?: unknown[]; closed?: unknown[] } = {}): GithubReads {
  return {
    async get<T>(_what: string, path: string): Promise<T> {
      if (path.includes('state=open')) return (over.open ?? []) as T;
      return (over.closed ?? []) as T;
    },
    getPull: over.getPull ?? (async () => ({ mergeable: true }) as never),
    listReviews: over.listReviews ?? (async () => []),
    checks: over.checks ?? (async () => ({ total: 1, passed: 1, pending: [], failed: [], skipped: [] })),
  };
}
const rawPr = (n: number, extra = {}) => ({ number: n, title: `PET-${n}: thing`, html_url: `https://x/${n}`, user: { login: 'u' }, head: { sha: 'a'.repeat(40), ref: `pet-${n}-x` }, updated_at: '2026-10-19T00:00:00Z', ...extra });

describe('collectRepo', () => {
  it('reports a repo that errors as not read, never as empty', async () => {
    const gh = fakeGh();
    gh.get = async () => { throw new Error('HTTP 404'); };
    const r = await collectRepo(gh, 'o', 'r', new Date());
    expect(r).toMatchObject({ ok: false });
  });
  it('records a failed check read as a gap on that PR only', async () => {
    const r = await collectRepo(fakeGh({ open: [rawPr(1), rawPr(2)], checks: async (_r, sha) => { if (sha) throw new Error('boom'); throw new Error(); } }), 'o', 'r', new Date());
    expect(r.ok && r.open[0]!.gaps[0]).toContain('checks');
    expect(r.ok && r.open[0]!.checks).toBeNull();
  });
});

const AT = new Date('2026-10-20T11:52:00Z');
const pr = (over: Partial<OpenPr> = {}): OpenPr => ({
  repo: 'petedio-iac', number: 460, title: 'PET-670 x', url: 'https://x/460', draft: false, author: 'u', headSha: 'b'.repeat(40), headRef: 'pet-670-x',
  updatedAt: '2026-10-19T00:00:00Z', mergeable: true, petKeys: [670], checks: { total: 2, passed: 2, pending: [], failed: [], skipped: [] }, codex: [], gaps: [], ...over,
});
const item = (seq: number, over: Partial<PlaneItem> = {}): PlaneItem => ({ id: `i${seq}`, seq, name: `Item ${seq}`, stateName: 'In Review', stateGroup: 'started', labels: ['cloud'], parent: 'p', targetDate: null, updatedAt: '2026-10-19T00:00:00Z', priority: 'none', ...over });
const planeOk = (items: PlaneItem[]): PlaneRead => ({ ok: true, items, states: 5, labels: 5 });
const repoOk = (open: OpenPr[], closed: ClosedPr[] = []): RepoRead => ({ repo: 'petedio-iac', ok: true, open, closed, closedRead: closed.length });
const snap = (repos: RepoRead[], plane: PlaneRead): Snapshot => ({ at: AT, repos, plane });
const cx = (verdict: 'changes-requested' | 'escalate' | 'no-blocking', commitId: string, submittedAt = '2026-10-19T10:00:00Z') => ({ verdict, commitId, url: '', submittedAt });

describe('actionFor', () => {
  it('ranks a conflict before CI and Codex', () => {
    expect(actionFor(pr({ mergeable: false })).action).toBe('conflict');
  });
  it('calls a PR ready only when Codex is clean on this head', () => {
    const head = 'b'.repeat(40);
    expect(actionFor(pr({ codex: [cx('no-blocking', head)] })).action).toBe('ready');
    expect(actionFor(pr({ codex: [cx('no-blocking', 'c'.repeat(40))] })).action).toBe('waiting-codex');
    expect(actionFor(pr({ codex: [cx('escalate', head)] })).action).toBe('escalated');
  });
});

describe('buildMorning', () => {
  it('opens with what it read and lists each PR', () => {
    const out = buildMorning(snap([repoOk([pr()])], planeOk([item(670)])), new Map());
    expect(out).toContain('Read: 1 open and 0 recently closed PRs in 1 of 1 repos');
    expect(out).toContain('iac#460');
    expect(out).not.toContain('INCOMPLETE');
  });
  it('says INCOMPLETE and names a repo it could not read', () => {
    const out = buildMorning(snap([{ repo: 'petedio-vault', ok: false, error: 'HTTP 404' }], planeOk([item(1)])), new Map());
    expect(out).toContain('INCOMPLETE');
    expect(out).toContain('petedio-vault not read: HTTP 404');
    expect(out).toContain('no repo was read');
  });
  it('shows the newest comment on a needs-pedro item without interpreting it', () => {
    const out = buildMorning(snap([repoOk([])], planeOk([item(5, { labels: ['needs-pedro'] })])), new Map([[5, { at: '2026-10-19T01:00:00Z', text: 'Decide X' }]]));
    expect(out).toContain('2026-10-19: Decide X');
  });
});

describe('buildAudit', () => {
  const merged: ClosedPr = { repo: 'petedio-iac', number: 9, title: 'PET-8: y', url: 'https://x/9', headSha: 'd'.repeat(40), headRef: 'pet-8-y', closedAt: '2026-10-18T00:00:00Z', mergedAt: '2026-10-18T00:00:00Z', petKeys: [8], codex: null };
  it('finds an open PR on a Todo item, a merged PR on an open item, and an In Review item with no PR', () => {
    const out = buildAudit(snap([repoOk([pr()], [merged])], planeOk([item(670, { stateName: 'Todo', stateGroup: 'unstarted' }), item(8), item(30)])), null);
    expect(out).toMatch(/move to In Review \(1\)[\s\S]*PET-670/);
    expect(out).toMatch(/not Done: move to Done or In Progress \(1\)[\s\S]*PET-8/);
    expect(out).toMatch(/In Review with no open PR[^\n]*\(1\)[\s\S]*PET-30/);
  });
  it('leaves a -part- merge alone, since it keeps the item open', () => {
    const part = { ...merged, headRef: 'pet-8-part-1' };
    const out = buildAudit(snap([repoOk([], [part])], planeOk([item(8)])), null);
    expect(out).toMatch(/not Done: move to Done or In Progress \(0\)/);
  });
  it('refuses to audit when Plane was not read', () => {
    const out = buildAudit(snap([repoOk([])], { ok: false, error: 'HTTP 502' }), null);
    expect(out).toContain('INCOMPLETE');
    expect(out).toContain('Nothing below this line was checked');
  });
  it('says the vault was not read when no path is set', () => {
    expect(buildAudit(snap([repoOk([])], planeOk([item(1)])), null)).toContain('REPORT_VAULT_PATH');
  });
});

describe('buildSweep', () => {
  it('flags a conflict, red CI and an idle PR, and says threads were not read', () => {
    const red = pr({ number: 5, checks: { total: 1, passed: 0, pending: [], failed: ['validate (failure)'], skipped: [] } });
    const idle = pr({ number: 6, updatedAt: '2026-10-10T00:00:00Z' });
    const out = buildSweep(snap([repoOk([pr({ mergeable: false }), red, idle])], planeOk([item(1)])), 3);
    expect(out).toMatch(/merge conflict \(1\)/);
    expect(out).toMatch(/red CI \(1\)[\s\S]*validate/);
    expect(out).toMatch(/idle 3 days or more \(\d\)/);
    expect(out).toContain('Threads: not read');
  });
  it('detects a merge over a Codex "Changes requested", at the head or arriving later', () => {
    const base: ClosedPr = { repo: 'petedio-iac', number: 1, title: 't', url: 'u', headSha: 'e'.repeat(40), headRef: 'x', closedAt: '', mergedAt: '2026-10-19T12:00:00Z', petKeys: [], codex: [cx('changes-requested', 'e'.repeat(40), '2026-10-19T11:58:00Z')] };
    expect(mergedOverCodex(base)).toContain('merged anyway');
    expect(mergedOverCodex({ ...base, codex: [cx('changes-requested', 'f'.repeat(40), '2026-10-19T12:01:00Z')] })).toContain('after the merge');
    expect(mergedOverCodex({ ...base, codex: [cx('no-blocking', 'e'.repeat(40), '2026-10-19T11:58:00Z')] })).toBeNull();
    expect(mergedOverCodex({ ...base, codex: null })).toBeNull();
  });
});

describe('chunk', () => {
  it('splits at line breaks under the limit', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const parts = chunk(text, 500);
    expect(parts.every((p) => p.length <= 500)).toBe(true);
    expect(parts.join('\n')).toBe(text);
  });
});

describe('ReportRunner', () => {
  const settings = (statePath: string): ReportSettings => ({
    org: 'o', repos: ['r'], appId: '1', installationId: '2', privateKeyPem: PEM, plane: null,
    enabled: new Set(['morning', 'audit', 'sweep']), sweepWeekly: false, staleDays: 3, statePath, vaultPath: '',
  });
  const log = { info() {}, warn() {}, error() {} };
  const dir = () => join(mkdtempSync(join(tmpdir(), 'rep-')), 'state.json');

  it('sends a due report once and remembers the date across a restart', async () => {
    const sent: string[] = [];
    const path = dir();
    const mk = () => new ReportRunner({ settings: settings(path), github: fakeGh(), plane: null, sender: { send: async (t) => void sent.push(t) }, log, now: () => AT });
    await mk().tick();
    expect(sent.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(path, 'utf8')).dates.morning).toBe('2026-10-20');
    const before = sent.length;
    await mk().tick();
    expect(sent.length).toBe(before);
  });
  it('sends a failure DM when neither GitHub nor Plane can be read, and still counts the day', async () => {
    const sent: string[] = [];
    const gh = fakeGh();
    gh.get = async () => { throw new Error('HTTP 401'); };
    const r = new ReportRunner({ settings: settings(dir()), github: gh, plane: null, sender: { send: async (t) => void sent.push(t) }, log, now: () => AT });
    await r.tick();
    expect(sent[0]).toContain('report failed');
    expect(r.status().last.morning).toMatchObject({ ok: false });
  });
  it('does not count a report whose DM failed, so the next tick tries again', async () => {
    let fail = true;
    const sent: string[] = [];
    const path = dir();
    const r = new ReportRunner({ settings: settings(path), github: fakeGh(), plane: null, sender: { send: async (t) => { if (fail) throw new Error('discord down'); sent.push(t); } }, log, now: () => AT });
    await r.tick();
    expect(sent.length).toBe(0);
    fail = false;
    await r.tick();
    expect(sent.length).toBeGreaterThan(0);
  });
  it('reads Plane as not read when no key is set, and says so in the report', async () => {
    const sent: string[] = [];
    const r = new ReportRunner({ settings: settings(dir()), github: fakeGh({ open: [rawPr(1)] }), plane: null, sender: { send: async (t) => void sent.push(t) }, log, now: () => AT });
    await r.run('morning', { markRun: false });
    expect(sent.join('\n')).toContain('Plane not read');
    expect(sent.join('\n')).toContain('INCOMPLETE');
  });
});
