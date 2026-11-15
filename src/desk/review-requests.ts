/**
 * Second-opinion Codex reviews, requested by a thread (not by the merge desk's poll).
 *
 * WHY. Claude's review is the review of record. Codex is an optional second opinion, and a
 * thread asks for one when it wants it. Threads cannot reach codex-248, but this process can:
 * the desk's CodexQueue already holds the forced-command key (roles/codex, PET-591). A thread
 * reaches it through lab-agent's `queue_codex_review` tool, which calls /v1/codex-review.
 *
 * ⚠ SAME PATH, SAME LIMITS. The request goes through the desk's own CodexQueue, so it runs one
 * review at a time and the gate's repo-name check applies. It is also limited to DESK_REPOS,
 * so a caller cannot name a repository the desk does not watch.
 *
 * ⚠ THE RESULT IS THE REVIEW ON GITHUB, NOT THE EXIT CODE. A zero exit with no Codex review
 * of the head is a failure here, as it is in the desk (the recurring green-over-nothing bug).
 * Quota refusals are reported as `rate_limited`, apart from other failures.
 *
 * Requests live in memory. A restart forgets them, and `status` then answers from GitHub alone.
 */
import { codexReviews, type CodexQueue, type CodexReview, type Effort } from './codex.js';
import type { GitHubApp } from './github.js';

export type RequestState = 'queued' | 'done' | 'failed' | 'rate_limited';

export interface ReviewRequest {
  repo: string;
  pr: number;
  sha: string;
  effort: Effort;
  /** `queued` covers both waiting for the gate's lock and running: the gate does not say which. */
  state: RequestState;
  requestedAt: string;
  finishedAt?: string;
  /** For failed and rate_limited: the last lines of the gate's output. For done: the verdict. */
  detail?: string;
}

export type RequestOutcome =
  | { kind: 'queued'; request: ReviewRequest }
  | { kind: 'already-queued'; request: ReviewRequest }
  | { kind: 'already-reviewed'; sha: string; review: CodexReview }
  | { kind: 'refused'; reason: string };

export interface RequestDeps {
  queue: Pick<CodexQueue, 'enqueue'>;
  github: Pick<GitHubApp, 'getPull' | 'listReviews'>;
  /** DESK_REPOS: the only repositories a request may name. */
  repos: string[];
  log: { info(m: string): void; warn(m: string): void; error(m: string): void };
  /** Called once a request will queue, before the queue call, so the desk knows Codex is required for the PR. */
  onQueued?: (repo: string, pr: number, sha: string) => void;
  now?: () => Date;
}

const QUOTA = /rate_limit_reached|codex-quota/;
const KEEP = 200;

export class CodexReviewRequests {
  private readonly requests = new Map<string, ReviewRequest>();
  /** A request is in flight from its first call until it has decided to queue or not. A concurrent call for the same PR waits on it, so two POSTs cannot both queue. */
  private readonly deciding = new Map<string, Promise<RequestOutcome>>();

  constructor(private readonly deps: RequestDeps) {}

  private key(repo: string, pr: number): string {
    return `${repo}#${pr}`;
  }

  async request(repo: string, pr: number, effort: Effort = 'medium'): Promise<RequestOutcome> {
    const key = this.key(repo, pr);
    const running = this.deciding.get(key);
    if (running) {
      const first = await running;
      return first.kind === 'queued' ? { kind: 'already-queued', request: first.request } : first;
    }
    const decision = this.decide(repo, pr, effort);
    this.deciding.set(key, decision);
    try {
      return await decision;
    } finally {
      this.deciding.delete(key);
    }
  }

  private async decide(repo: string, pr: number, effort: Effort): Promise<RequestOutcome> {
    if (!this.deps.repos.includes(repo)) return { kind: 'refused', reason: `${repo} is not on the desk's repository list (${this.deps.repos.join(', ')})` };
    const pull = await this.deps.github.getPull(repo, pr);
    if (pull.state !== 'open' || pull.merged) return { kind: 'refused', reason: `${repo}#${pr} is not open` };
    const sha = pull.headSha;

    const onHead = codexReviews(await this.deps.github.listReviews(repo, pr)).filter((r) => r.commitId === sha);
    if (onHead.length > 0) return { kind: 'already-reviewed', sha, review: onHead[onHead.length - 1]! };

    const prior = this.requests.get(this.key(repo, pr));
    if (prior && prior.sha === sha && prior.state === 'queued') return { kind: 'already-queued', request: prior };

    const request: ReviewRequest = { repo, pr, sha, effort, state: 'queued', requestedAt: (this.deps.now?.() ?? new Date()).toISOString() };
    this.requests.set(this.key(repo, pr), request);
    this.prune();
    this.deps.onQueued?.(repo, pr, sha);
    this.deps.log.info(`codex second opinion: queueing (${effort}) for ${repo}#${pr} at ${sha.slice(0, 7)}`);
    void this.run(request);
    return { kind: 'queued', request };
  }

  private async run(request: ReviewRequest): Promise<void> {
    const { repo, pr, sha } = request;
    const finish = (state: RequestState, detail: string) => {
      request.state = state;
      request.detail = detail;
      request.finishedAt = (this.deps.now?.() ?? new Date()).toISOString();
    };
    try {
      const r = await this.deps.queue.enqueue(repo, pr, request.effort);
      if (!r.ok) {
        const quota = QUOTA.test(r.tail);
        finish(quota ? 'rate_limited' : 'failed', quota ? `Codex is out of quota. ${r.tail}` : `codex-review exited ${r.exitCode ?? 'killed'}. ${r.tail}`);
        this.deps.log.warn(`codex second opinion: ${repo}#${pr} at ${sha.slice(0, 7)} ${request.state}`);
        return;
      }
      const reviewed = codexReviews(await this.deps.github.listReviews(repo, pr)).filter((x) => x.commitId === sha);
      if (reviewed.length > 0) {
        finish('done', reviewed[reviewed.length - 1]!.verdict);
        return;
      }
      // Codex reviews the head at the time it starts. A push while it ran moves the head.
      const head = (await this.deps.github.getPull(repo, pr)).headSha;
      finish('failed', head !== sha ? `the head moved to ${head.slice(0, 7)} while Codex ran, so it reviewed a different commit` : `codex-review exited 0, but no Codex review of ${sha.slice(0, 7)} appeared`);
    } catch (err) {
      finish('failed', `the request failed while it checked the result: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400));
      this.deps.log.error(`codex second opinion: ${repo}#${pr}: ${String(err)}`);
    }
  }

  /** What this process knows, plus the Codex reviews GitHub shows. Both are read each call. */
  async status(repo: string, pr: number): Promise<{ head: string; request: ReviewRequest | null; reviews: Array<CodexReview & { onHead: boolean }> }> {
    if (!this.deps.repos.includes(repo)) throw new RefusedError(`${repo} is not on the desk's repository list`);
    const pull = await this.deps.github.getPull(repo, pr);
    const reviews = codexReviews(await this.deps.github.listReviews(repo, pr)).map((r) => ({ ...r, onHead: r.commitId === pull.headSha }));
    return { head: pull.headSha, request: this.requests.get(this.key(repo, pr)) ?? null, reviews };
  }

  private prune(): void {
    while (this.requests.size > KEEP) this.requests.delete(this.requests.keys().next().value as string);
  }
}

export class RefusedError extends Error {
  override name = 'RefusedError';
}
