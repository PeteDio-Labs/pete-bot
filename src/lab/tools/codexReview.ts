/**
 * queue_codex_review and codex_review_status: a thread's way to ask for Codex as a second
 * opinion. The lab MCP serves them. The /lab model loop and the media assistant do not.
 *
 * ⚠ queue_codex_review CHANGES SOMETHING: it starts a Codex run on codex-248, which spends
 * Codex quota and posts a review on the PR. It holds no key to 248. It asks pete-bot's
 * /v1/codex-review, which owns the desk's Codex queue and refuses any repository that is not
 * on the desk's list.
 *
 * ⚠ QUOTA IS REPORTED, NOT HIDDEN. When the gate says Codex is out of quota, the status reads
 * `rate_limited`. A review that never appeared is `failed`. Neither reads as "no findings".
 *
 * The review is not instant. queue returns at once; poll codex_review_status.
 */
import { z } from 'zod';
import { fetchWithTimeout, LabToolError, type LabTool } from './types.js';

export interface CodexReviewConfig {
  /** Such as http://127.0.0.1:3015/v1/codex-review */
  url: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const repo = z.string().regex(/^[a-z0-9-]+$/, 'a plain repository name, without the org').describe('Repository name without the org, such as petedio-iac');
const pr = z.number().int().min(1).describe('Pull request number');

async function call(cfg: CodexReviewConfig, method: 'GET' | 'POST', repoName: string, n: number, effort?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(cfg.url);
  if (method === 'GET') {
    url.searchParams.set('repo', repoName);
    url.searchParams.set('pr', String(n));
  }
  const res = await fetchWithTimeout(
    cfg.fetch ?? fetch,
    url.toString(),
    {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: method === 'POST' ? JSON.stringify({ repo: repoName, pr: n, ...(effort ? { effort } : {}) }) : undefined,
      redirect: 'error',
    },
    cfg.timeoutMs ?? 30_000,
    'pete-bot codex-review',
  );
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new LabToolError(`pete-bot answered HTTP ${res.status} with a body that is not JSON`);
  }
  if (res.status === 401) throw new LabToolError('pete-bot refused the lab-agent Codex token (HTTP 401)');
  if (res.status === 503) throw new LabToolError('the merge desk is off, so there is no Codex queue to use');
  if (res.status === 403) throw new LabToolError(`refused: ${String(body.detail ?? 'not allowed')}`);
  if (!res.ok) throw new LabToolError(`pete-bot answered HTTP ${res.status}: ${String(body.detail ?? body.error ?? '').slice(0, 200)}`);
  return { status: res.status, body };
}

export function queueCodexReviewTool(cfg: CodexReviewConfig): LabTool {
  const input = z.object({
    repo,
    pr,
    effort: z.enum(['low', 'medium', 'high']).optional().describe('How hard Codex reads. Medium by default; high for anything that runs on merge'),
  });
  return {
    name: 'queue_codex_review',
    readOnly: false,
    description:
      'Queue a Codex review of one open PR on the merge desk repositories, as a second opinion. Claude review is the review of record; use this sometimes, for risky changes, not on every PR. ' +
      'It spends Codex quota and posts a review on the PR when it finishes, which takes minutes. A second opinion you queue is still required before the PR merges. ' +
      'It answers at once with `queued`, `already-queued` or `already-reviewed` (the head already has a Codex review). Then poll codex_review_status.',
    input,
    async run({ repo: r, pr: n, effort }: z.infer<typeof input>) {
      const { body } = await call(cfg, 'POST', r, n, effort);
      return { source: `pete-bot /v1/codex-review for ${r}#${n}`, data: body };
    },
  };
}

export function codexReviewStatusTool(cfg: CodexReviewConfig): LabTool {
  const input = z.object({ repo, pr });
  return {
    name: 'codex_review_status',
    description:
      'Where a Codex second opinion stands for one PR: the request (queued, done, failed or rate_limited, with the gate output) and every Codex review GitHub shows, each marked onHead or stale. ' +
      '`rate_limited` means Codex is out of quota; it is not a clean review. A review with onHead false says nothing about the current head.',
    input,
    async run({ repo: r, pr: n }: z.infer<typeof input>) {
      const { body } = await call(cfg, 'GET', r, n);
      const reviews = Array.isArray(body.reviews) ? body.reviews.length : 0;
      return { source: `pete-bot /v1/codex-review for ${r}#${n}: ${reviews} Codex review(s) on the PR, request ${body.request ? 'known' : 'none in memory'}`, data: body };
    },
  };
}
