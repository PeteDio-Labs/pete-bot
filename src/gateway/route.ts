/**
 * POST /v1/llm/v1/messages — the homelab's one door to the Anthropic API (PET-617).
 *
 * WHY A GATEWAY. One Anthropic key backs every homelab agent, and the key lives in this
 * process alone. Each caller gets its own bearer and a monthly dollar cap, and every
 * answered request lands in the ledger with its tokens and cost. A caller never holds the
 * key, so revoking one caller means removing one bearer, not rotating the key.
 *
 * WHY THAT PATH. A caller uses the official SDK with `baseURL` set to
 * `http://<host>:3015/v1/llm`, and the SDK appends `/v1/messages` itself. The shorter
 * `/v1/llm/messages`, the name PET-617's plan uses, routes to the same handler.
 *
 * WHY RAW fetch AND NOT THE SDK. This is a reverse proxy, not a client. It forwards the
 * caller's body unchanged, so a parameter or beta header the SDK version here does not
 * know still reaches the API. The callers use the SDK.
 *
 * WHAT IT REFUSES, AND WHY EACH STATUS. The SDK retries 408, 409, 429 and 5xx, so every
 * refusal a retry cannot fix is a 4xx it does not retry:
 *
 *   503  the gateway is off or misconfigured (a retry may succeed after a deploy)
 *   401  no bearer, or one that matches no caller
 *   400  no model, no max_tokens, or `stream: true`
 *   403  a model this caller may not use, or a caller already at its monthly cap
 *
 * ⚠ THE CAP IS CHECKED BEFORE A REQUEST, SO ONE REQUEST CAN CROSS IT. The cost is known
 * only from the response. A caller at $14.99 of $15 gets one more answer, and is refused
 * after it. Concurrent requests from one caller can each cross it once.
 *
 * ⚠ NO STREAMING YET. The ledger reads `usage` from a whole response. A streamed response
 * spreads it across events, and that parsing is not written.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../utils/index.js';
import type { Caller, GatewaySettings } from './config.js';
import { Ledger } from './ledger.js';
import { canonicalModel, costNanoUsd, priceFor, type Usage } from './pricing.js';

export const LLM_ROUTES = ['/v1/llm/v1/messages', '/v1/llm/messages'];

const UPSTREAM = 'https://api.anthropic.com/v1/messages';
const DEFAULT_VERSION = '2023-06-01';
/** Long enough for a large non-streaming answer; past it the caller gets a 504. */
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

/** Response headers the caller's SDK reads, passed back unchanged. */
const PASSTHROUGH_HEADERS = ['request-id', 'retry-after', 'anthropic-organization-id'];

const RequestSchema = z
  .object({
    model: z.string().min(1),
    max_tokens: z.number().int().positive(),
    stream: z.literal(false).optional(),
  })
  .passthrough();

export interface Gateway {
  readonly state: GatewaySettings['state'];
  handle(req: Request, res: Response): Promise<void>;
  close(): void;
}

export interface GatewayDeps {
  fetch?: typeof fetch;
  /** Tests pass a ':memory:' ledger; production opens settings.ledgerPath. */
  ledger?: Ledger;
  now?: () => Date;
}

/** The error shape the Anthropic API returns, so the caller's SDK reads it as one. */
function refuse(res: Response, status: number, type: string, message: string): void {
  res.status(status).json({ type: 'error', error: { type, message } });
}

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Compare against every caller, so the time taken says nothing about which one matched. */
function findCaller(callers: Caller[], presented: string): Caller | undefined {
  const got = digest(presented);
  let match: Caller | undefined;
  for (const c of callers) {
    if (timingSafeEqual(got, digest(c.token)) && !match) match = c;
  }
  return match;
}

/** The SDK sends `x-api-key` when given apiKey, and `Authorization: Bearer` for authToken. */
function presentedToken(req: Request): string {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
  return bearer?.[1] ?? req.header('x-api-key') ?? '';
}

const usd = (nano: number): string => `$${(nano / 1e9).toFixed(2)}`;

export function createGateway(settings: GatewaySettings, deps: GatewayDeps = {}): Gateway {
  if (settings.state !== 'on') {
    if (settings.state === 'misconfigured') {
      logger.error(`LLM gateway is misconfigured and will refuse every request: ${settings.reason}`);
    }
    return {
      state: settings.state,
      async handle(_req, res) {
        refuse(res, 503, 'api_error', `the LLM gateway is ${settings.state}`);
      },
      close() {},
    };
  }

  const { apiKey, callers } = settings;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const ledger = deps.ledger ?? new Ledger(settings.ledgerPath);
  logger.info(`LLM gateway is on for ${callers.map((c) => c.name).join(', ')}`);

  async function handle(req: Request, res: Response): Promise<void> {
    const presented = presentedToken(req);
    const caller = presented ? findCaller(callers, presented) : undefined;
    if (!caller) {
      refuse(res, 401, 'authentication_error', 'unknown gateway token');
      return;
    }

    const parsed = RequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      refuse(res, 400, 'invalid_request_error', `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
      return;
    }
    const { model } = parsed.data;

    const alias = canonicalModel(model);
    if (!alias || !caller.models.has(alias)) {
      refuse(res, 403, 'permission_error', `${caller.name} may not use ${model}`);
      return;
    }

    let spent: number;
    try {
      spent = ledger.spentNanoUsd(caller.name, now());
    } catch (err) {
      // A ledger that cannot be read cannot enforce a cap, so nothing is forwarded.
      logger.error(`LLM gateway could not read the ledger: ${err instanceof Error ? err.message : String(err)}`);
      refuse(res, 503, 'api_error', 'the LLM gateway ledger is unavailable');
      return;
    }
    if (spent >= caller.capNanoUsd) {
      refuse(res, 403, 'permission_error', `${caller.name} has spent ${usd(spent)} of its ${usd(caller.capNanoUsd)} monthly cap`);
      return;
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': req.header('anthropic-version') ?? DEFAULT_VERSION,
    };
    const beta = req.header('anthropic-beta');
    if (beta) headers['anthropic-beta'] = beta;

    let upstream: globalThis.Response;
    try {
      upstream = await doFetch(UPSTREAM, {
        method: 'POST',
        headers,
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      logger.error(`LLM gateway could not reach the API for ${caller.name}: ${err instanceof Error ? err.message : String(err)}`);
      refuse(res, timedOut ? 504 : 502, 'api_error', timedOut ? 'the API did not answer in time' : 'the API is unreachable');
      return;
    }

    const text = await upstream.text();

    if (upstream.ok) {
      recordUsage(caller, model, text, upstream.headers.get('request-id') ?? undefined);
    }

    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') ?? 'application/json');
    for (const h of PASSTHROUGH_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.send(text);
  }

  /**
   * Price and record one answered request. A failure here is logged and the answer still
   * goes back: the tokens are spent either way, and a 5xx would make the SDK retry and
   * spend them again.
   */
  function recordUsage(caller: Caller, requested: string, text: string, requestId?: string): void {
    try {
      const body = JSON.parse(text) as { model?: string; usage?: Usage };
      const model = typeof body.model === 'string' && priceFor(body.model) ? body.model : requested;
      const usage = body.usage ?? {};
      const cost = costNanoUsd(priceFor(model)!, usage);
      const cacheWrite =
        (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) ||
        (usage.cache_creation_input_tokens ?? 0);
      ledger.record(
        {
          caller: caller.name,
          model,
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: cacheWrite,
          costNanoUsd: cost,
          requestId,
        },
        now(),
      );
      // Who, what and how much. Never the prompt or the answer.
      logger.info(`LLM gateway: ${caller.name} ${model} in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0} cost=${usd(cost)}`);
    } catch (err) {
      logger.error(
        `LLM gateway answered ${caller.name} but could not record the cost: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    state: 'on',
    handle,
    close: () => ledger.close(),
  };
}
