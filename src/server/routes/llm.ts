/**
 * GET /v1/llm/calls?limit=100 and GET /v1/llm/usage: the audit the dashboard reads.
 * Bearer LLM_READ_BEARER_TOKEN, read only. Records carry hashes and lengths, never text.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { getLlm } from '../../llm/runtime.js';

function authorized(req: Request): boolean {
  const expected = process.env.LLM_READ_BEARER_TOKEN ?? '';
  const got = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!expected || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export function llmCallsHandler() {
  return (req: Request, res: Response): void => {
    if (!authorized(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500);
    const calls = getLlm().tracker.calls(limit);
    res.json({ examined: calls.length, calls });
  };
}

export function llmUsageHandler() {
  return (req: Request, res: Response): void => {
    if (!authorized(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const { tracker, gateway } = getLlm();
    res.json({ ...tracker.usage(), capUsd: Number(process.env.LLM_HAIKU_MONTHLY_CAP_USD || 100), queueDepth: gateway.depth() });
  };
}
