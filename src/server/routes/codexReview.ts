/**
 * /v1/codex-review — queue a second-opinion Codex review of one PR, and read where it stands.
 *
 *   POST {"repo": "petedio-iac", "pr": 123, "effort": "medium"}   → 202 queued, 200 already-queued or
 *                                                                   already-reviewed, 403 not allowed
 *   GET  ?repo=petedio-iac&pr=123                                  → the request and Codex's reviews
 *
 * Its own bearer (CODEX_REVIEW_BEARER_TOKEN), so no other token opens it. A review takes
 * minutes, so POST answers at once and a caller polls GET. A quota refusal shows up there as
 * `rate_limited`. lab-agent's `queue_codex_review` tool is the only intended caller.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { getReviewRequests } from '../../desk/index.js';
import { RefusedError } from '../../desk/review-requests.js';
import { REPO_NAME } from '../../desk/config.js';
import { logger } from '../../utils/index.js';

const Body = z.object({
  repo: z.string().regex(REPO_NAME),
  pr: z.number().int().min(1),
  effort: z.enum(['low', 'medium', 'high']).optional(),
});
const Query = z.object({ repo: z.string().regex(REPO_NAME), pr: z.coerce.number().int().min(1) });

function authorized(req: Request): boolean {
  const expected = config.httpServer.codexReviewToken;
  const got = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  return Boolean(expected) && got.length === expected.length && got === expected;
}

export function codexReviewHandler() {
  return async function handler(req: Request, res: Response): Promise<void> {
    if (!authorized(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const post = req.method === 'POST';
    const parsed = post ? Body.safeParse(req.body) : Query.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad payload', detail: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`) });
      return;
    }
    const requests = getReviewRequests();
    if (!requests) {
      res.status(503).json({ error: 'desk_off', detail: 'the merge desk is off or misconfigured, so it holds no Codex queue' });
      return;
    }
    const { repo, pr } = parsed.data;
    try {
      if (!post) {
        res.json({ ok: true, repo, pr, ...(await requests.status(repo, pr)) });
        return;
      }
      const out = await requests.request(repo, pr, (parsed.data as z.infer<typeof Body>).effort);
      // Log which PR, never any body text.
      logger.info(`/v1/codex-review ${repo}#${pr}: ${out.kind}`);
      if (out.kind === 'refused') res.status(403).json({ error: 'refused', detail: out.reason });
      else res.status(out.kind === 'queued' ? 202 : 200).json({ ok: true, repo, pr, ...out });
    } catch (err) {
      if (err instanceof RefusedError) {
        res.status(403).json({ error: 'refused', detail: err.message });
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      logger.error(`/v1/codex-review ${repo}#${pr}: ${detail}`);
      res.status(502).json({ error: 'github_failed', detail: detail.slice(0, 300) });
    }
  };
}
