/**
 * The merge desk's GitHub client (PET-645). It speaks as pete-bot's own GitHub App.
 *
 * ⚠ THE APP KEY NEVER LEAVES THIS PROCESS. The key signs a ten-minute JWT, the JWT buys an
 * installation token, and the token is cached until five minutes before it expires. No
 * token or key is logged, and no error message carries one.
 *
 * ⚠ fetch HAS NO DEFAULT TIMEOUT. Every call carries one, so a stalled API cannot hang a
 * poll forever and stop every later one.
 */
import { createSign } from 'node:crypto';

const API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 20_000;

export interface PullSummary {
  number: number;
  title: string;
  draft: boolean;
  author: string;
  headSha: string;
  headRepo: string;
  baseRef: string;
  htmlUrl: string;
  labels: string[];
}

export interface PullDetail extends PullSummary {
  state: string;
  merged: boolean;
  /** null while GitHub is still computing it. */
  mergeable: boolean | null;
  mergeableState: string;
}

export interface Review {
  id: number;
  author: string;
  commitId: string;
  state: string;
  body: string;
  htmlUrl: string;
  submittedAt: string;
}

export interface CheckSummary {
  /** Check runs and commit statuses on the head, counted together. */
  total: number;
  passed: number;
  pending: string[];
  failed: string[];
}

export interface FileChange {
  path: string;
  previousPath?: string;
}

export type MergeResult = { ok: true; sha: string } | { ok: false; status: number; message: string };

export class GitHubError extends Error {
  constructor(
    readonly what: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${what} failed: GitHub answered HTTP ${status} ${detail}`.trim());
  }
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** A GitHub App JWT. iat sits 60 seconds in the past to absorb clock skew, as GitHub advises. */
export function appJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(privateKeyPem))}`;
}

type Fetch = typeof fetch;

export interface GitHubAppOptions {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  org: string;
  fetchImpl?: Fetch;
  now?: () => number;
}

export class GitHubApp {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: Fetch;
  private readonly now: () => number;

  constructor(private readonly opts: GitHubAppOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async installationToken(): Promise<string> {
    if (this.token && this.token.expiresAt - this.now() > 5 * 60_000) return this.token.value;
    const jwt = appJwt(this.opts.appId, this.opts.privateKeyPem, Math.floor(this.now() / 1000));
    const res = await this.fetchImpl(`${API}/app/installations/${this.opts.installationId}/access_tokens`, {
      method: 'POST',
      headers: this.headers(jwt),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new GitHubError('minting an installation token', res.status, await short(res));
    const body = (await res.json()) as { token: string; expires_at: string };
    this.token = { value: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
  }

  private headers(bearer: string): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${bearer}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pete-bot-merge-desk',
    };
  }

  async request(path: string, init: { method?: string; body?: unknown; accept?: string } = {}): Promise<Response> {
    const token = await this.installationToken();
    const headers = this.headers(token);
    if (init.accept) headers.Accept = init.accept;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    return this.fetchImpl(path.startsWith('https://') ? path : `${API}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private async json<T>(what: string, path: string, init?: Parameters<GitHubApp['request']>[1]): Promise<T> {
    const res = await this.request(path, init);
    if (!res.ok) throw new GitHubError(what, res.status, await short(res));
    return (await res.json()) as T;
  }

  /** Follows `per_page=100` pages to the end, up to a bound that no real PR reaches. */
  private async pages<T>(what: string, path: string, maxPages = 30): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.json<T[]>(what, `${path}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) return out;
    }
    throw new Error(`${what}: more than ${maxPages * 100} items, refusing to judge a partial list`);
  }

  private repoPath(repo: string): string {
    return `/repos/${this.opts.org}/${repo}`;
  }

  async listOpenPulls(repo: string): Promise<PullSummary[]> {
    const raw = await this.pages<RawPull>(`listing ${repo}'s open PRs`, `${this.repoPath(repo)}/pulls?state=open`);
    return raw.map(summary);
  }

  async getPull(repo: string, n: number): Promise<PullDetail> {
    const raw = await this.json<RawPull>(`reading ${repo}#${n}`, `${this.repoPath(repo)}/pulls/${n}`);
    return {
      ...summary(raw),
      state: raw.state,
      merged: Boolean(raw.merged),
      mergeable: raw.mergeable ?? null,
      mergeableState: raw.mergeable_state ?? 'unknown',
    };
  }

  async listFiles(repo: string, n: number): Promise<FileChange[]> {
    const raw = await this.pages<{ filename: string; previous_filename?: string }>(
      `listing ${repo}#${n}'s files`,
      `${this.repoPath(repo)}/pulls/${n}/files`,
    );
    return raw.map((f) => ({ path: f.filename, previousPath: f.previous_filename }));
  }

  async listReviews(repo: string, n: number): Promise<Review[]> {
    const raw = await this.pages<RawReview>(`listing ${repo}#${n}'s reviews`, `${this.repoPath(repo)}/pulls/${n}/reviews`);
    return raw.map((r) => ({
      id: r.id,
      author: r.user?.login ?? '',
      commitId: r.commit_id ?? '',
      state: r.state,
      body: r.body ?? '',
      htmlUrl: r.html_url,
      submittedAt: r.submitted_at ?? '',
    }));
  }

  /**
   * Check runs and commit statuses on one commit. Only the latest run of each check counts,
   * and a skipped or neutral run passes.
   */
  async checks(repo: string, sha: string): Promise<CheckSummary> {
    const runs = await this.json<{ total_count: number; check_runs: RawCheckRun[] }>(
      `reading checks on ${sha.slice(0, 7)}`,
      `${this.repoPath(repo)}/commits/${sha}/check-runs?filter=latest&per_page=100`,
    );
    if (runs.total_count > runs.check_runs.length) {
      throw new Error(`${runs.total_count} check runs on ${sha.slice(0, 7)}, more than one page; refusing a partial read`);
    }
    const statuses = await this.json<{ statuses: { context: string; state: string }[] }>(
      `reading statuses on ${sha.slice(0, 7)}`,
      `${this.repoPath(repo)}/commits/${sha}/status?per_page=100`,
    );
    const out: CheckSummary = { total: 0, passed: 0, pending: [], failed: [] };
    for (const run of runs.check_runs) {
      out.total++;
      if (run.status !== 'completed') out.pending.push(run.name);
      else if (['success', 'neutral', 'skipped'].includes(run.conclusion ?? '')) out.passed++;
      else out.failed.push(`${run.name} (${run.conclusion})`);
    }
    for (const s of statuses.statuses) {
      out.total++;
      if (s.state === 'success') out.passed++;
      else if (s.state === 'pending') out.pending.push(s.context);
      else out.failed.push(`${s.context} (${s.state})`);
    }
    return out;
  }

  /** Unresolved review threads. A thread on an outdated line still counts until someone resolves it. */
  async unresolvedThreads(repo: string, n: number): Promise<number> {
    const query = `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){reviewThreads(first:100){totalCount nodes{isResolved}}}}}`;
    const body = await this.json<{
      data?: { repository?: { pullRequest?: { reviewThreads: { totalCount: number; nodes: { isResolved: boolean }[] } } } };
      errors?: { message: string }[];
    }>(`reading ${repo}#${n}'s review threads`, '/graphql', {
      method: 'POST',
      body: { query, variables: { owner: this.opts.org, repo, n } },
    });
    const threads = body.data?.repository?.pullRequest?.reviewThreads;
    if (body.errors?.length || !threads) {
      throw new Error(`reading ${repo}#${n}'s review threads: ${body.errors?.[0]?.message ?? 'no data'}`);
    }
    if (threads.totalCount > threads.nodes.length) {
      throw new Error(`${repo}#${n} has ${threads.totalCount} review threads, more than one page; refusing a partial read`);
    }
    return threads.nodes.filter((t) => !t.isResolved).length;
  }

  async defaultBranch(repo: string): Promise<string> {
    const r = await this.json<{ default_branch: string }>(`reading ${repo}`, this.repoPath(repo));
    return r.default_branch;
  }

  /** One file's text on a ref, or null when the file is not there. */
  async fileText(repo: string, path: string, ref: string): Promise<string | null> {
    const res = await this.request(`${this.repoPath(repo)}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
      accept: 'application/vnd.github.raw',
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubError(`reading ${repo}:${path}`, res.status, await short(res));
    return res.text();
  }

  /** File names in one directory on a ref; an absent directory is an empty list. */
  async listDir(repo: string, path: string, ref: string): Promise<string[]> {
    const res = await this.request(`${this.repoPath(repo)}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (res.status === 404) return [];
    if (!res.ok) throw new GitHubError(`listing ${repo}:${path}`, res.status, await short(res));
    const entries = (await res.json()) as { type: string; name: string }[];
    return entries.filter((e) => e.type === 'file').map((e) => e.name);
  }

  async approve(repo: string, n: number, sha: string, body: string): Promise<void> {
    await this.json(`approving ${repo}#${n}`, `${this.repoPath(repo)}/pulls/${n}/reviews`, {
      method: 'POST',
      body: { commit_id: sha, event: 'APPROVE', body },
    });
  }

  /** A squash merge pinned to `sha`. GitHub refuses it with 409 when the head has moved. */
  async merge(repo: string, n: number, sha: string, title: string): Promise<MergeResult> {
    const res = await this.request(`${this.repoPath(repo)}/pulls/${n}/merge`, {
      method: 'PUT',
      body: { sha, merge_method: 'squash', commit_title: `${title} (#${n})` },
    });
    if (res.ok) {
      const body = (await res.json()) as { sha: string };
      return { ok: true, sha: body.sha };
    }
    return { ok: false, status: res.status, message: await short(res) };
  }

  /** True when `sha` is on `branch`: the branch is that commit or descends from it. */
  async onBranch(repo: string, sha: string, branch: string): Promise<boolean> {
    const r = await this.json<{ status: string }>(
      `comparing ${sha.slice(0, 7)} with ${branch}`,
      `${this.repoPath(repo)}/compare/${sha}...${encodeURIComponent(branch)}`,
    );
    return r.status === 'identical' || r.status === 'ahead';
  }

  async comment(repo: string, n: number, body: string): Promise<void> {
    await this.json(`commenting on ${repo}#${n}`, `${this.repoPath(repo)}/issues/${n}/comments`, {
      method: 'POST',
      body: { body },
    });
  }
}

interface RawPull {
  number: number;
  title: string;
  draft?: boolean;
  state: string;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  html_url: string;
  user: { login: string } | null;
  head: { sha: string; repo: { full_name: string } | null };
  base: { ref: string };
  labels?: { name: string }[];
}

interface RawReview {
  id: number;
  user: { login: string } | null;
  commit_id: string | null;
  state: string;
  body: string | null;
  html_url: string;
  submitted_at?: string;
}

interface RawCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

function summary(raw: RawPull): PullSummary {
  return {
    number: raw.number,
    title: raw.title,
    draft: Boolean(raw.draft),
    author: raw.user?.login ?? '',
    headSha: raw.head.sha,
    headRepo: raw.head.repo?.full_name ?? '',
    baseRef: raw.base.ref,
    htmlUrl: raw.html_url,
    labels: (raw.labels ?? []).map((l) => l.name),
  };
}

async function short(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.slice(0, 200);
}
