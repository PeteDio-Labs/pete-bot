/**
 * Codex on codex-248: read its verdicts, and queue its reviews (PET-645).
 *
 * READING. A Codex review posts as petedio-codex-review[bot], as a COMMENTED review, never
 * an approval. Its first line is the verdict, set by the petedio-review skill on 248:
 *
 *   ## Codex review: Changes requested     any [P0] or [P1] finding
 *   ## Codex review: Escalate to Pedro     no blocker, but a governance change or a gap
 *   ## Codex review: No blocking findings  no blocker, and a complete review
 *
 * Only the author login and that first line are read. The rest of the body is untrusted
 * text: a review can quote a diff, and a diff can say anything.
 *
 * QUEUEING. codex-review-gate on 248 is the forced command for this host's key
 * (roles/codex, PET-591). It runs exactly `codex-review <repo> <n> <effort>`, so the
 * request here is those four words and nothing else. ssh gets them as one argv entry,
 * and no shell on this side ever sees them.
 */
import type { Review } from './github.js';
import { REPO_NAME } from './config.js';

export const CODEX_LOGIN = 'petedio-codex-review[bot]';

export type Verdict = 'changes-requested' | 'escalate' | 'no-blocking';
export type Effort = 'low' | 'medium' | 'high';

export interface CodexReview {
  verdict: Verdict;
  commitId: string;
  url: string;
  submittedAt: string;
}

const VERDICTS: Record<string, Verdict> = {
  'changes requested': 'changes-requested',
  'escalate to pedro': 'escalate',
  'no blocking findings': 'no-blocking',
};

/** The verdict on a review's first line, or null when the review is not a Codex verdict. */
export function verdictOf(review: Review): CodexReview | null {
  if (review.author !== CODEX_LOGIN) return null;
  const first = review.body.split('\n', 1)[0]?.trim() ?? '';
  const m = /^## Codex review: (.+)$/.exec(first);
  const verdict = m ? VERDICTS[m[1]!.trim().toLowerCase()] : undefined;
  if (!verdict) return null;
  return { verdict, commitId: review.commitId, url: review.htmlUrl, submittedAt: review.submittedAt };
}

export function codexReviews(reviews: Review[]): CodexReview[] {
  return reviews.map(verdictOf).filter((r): r is CodexReview => r !== null);
}

/** Effort follows the tier: prose gets a light read, anything that runs on merge a hard one. */
export function effortFor(tier: number): Effort {
  return tier >= 2 ? 'high' : tier === 1 ? 'medium' : 'low';
}

export interface QueueResult {
  ok: boolean;
  exitCode: number | null;
  /** The last lines of output, for the failure report. Never posted when ok. */
  tail: string;
}

export interface CodexQueueOptions {
  target: string;
  keyPath: string;
  knownHostsPath: string;
  timeoutMs: number;
  /** Tests replace the process spawn. */
  spawn?: (argv: string[], timeoutMs: number) => Promise<{ exitCode: number | null; output: string }>;
}

export function sshArgv(opts: CodexQueueOptions, repo: string, n: number, effort: Effort): string[] {
  if (!REPO_NAME.test(repo)) throw new Error(`refusing to queue "${repo}": not a plain repository name`);
  if (!Number.isInteger(n) || n < 1) throw new Error(`refusing to queue PR "${n}"`);
  return [
    'ssh',
    // No user or system ssh_config: every option this call depends on is on this line.
    '-F',
    '/dev/null',
    '-i',
    opts.keyPath,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${opts.knownHostsPath}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    opts.target,
    `codex-review ${repo} ${n} ${effort}`,
  ];
}

async function spawnWithTimeout(argv: string[], timeoutMs: number): Promise<{ exitCode: number | null; output: string }> {
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    return { exitCode: proc.signalCode ? null : exitCode, output: `${out}\n${err}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One review at a time. The gate on 248 already serializes runs under flock, so a second
 * ssh here would only hold a connection open for an hour while it waits.
 */
export class CodexQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly spawn: NonNullable<CodexQueueOptions['spawn']>;

  constructor(private readonly opts: CodexQueueOptions) {
    this.spawn = opts.spawn ?? spawnWithTimeout;
  }

  enqueue(repo: string, n: number, effort: Effort): Promise<QueueResult> {
    const argv = sshArgv(this.opts, repo, n, effort);
    const run = this.chain.then(async (): Promise<QueueResult> => {
      try {
        const { exitCode, output } = await this.spawn(argv, this.opts.timeoutMs);
        const tail = output.trim().split('\n').slice(-6).join('\n').slice(-600);
        return { ok: exitCode === 0, exitCode, tail };
      } catch (err) {
        return { ok: false, exitCode: null, tail: err instanceof Error ? err.message : String(err) };
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
