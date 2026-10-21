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
 *   503  the gateway is off or misconfigured, or its ledger failed (a retry may succeed
 *        after a deploy or a restart)
 *   401  no bearer, or one that matches no caller
 *   400  no model, no max_tokens, `stream: true`, a parameter the gateway cannot price,
 *        or a code execution tool
 *   403  a model this caller may not use, or a caller already at its monthly cap
 *   429  the caller already has MAX_IN_FLIGHT requests open (the SDK retries this one)
 *
 * ⚠ THE CAP IS CHECKED BEFORE A REQUEST, SO ONE REQUEST CAN CROSS IT. The cost is known
 * only from the response. A caller at $14.99 of $15 gets one more answer, and is refused
 * after it. MAX_IN_FLIGHT bounds the overshoot: at most that many answers cross the cap.
 *
 * ⚠ A PARAMETER MISSING FROM ALLOWED_PARAMS IS REFUSED. Some parameters change the price
 * of the same tokens: `speed: "fast"`, `inference_geo` and `service_tier` all bill above
 * the rates in pricing.ts, so a cap that forwarded them would undercount. Add a parameter
 * here only once pricing.ts prices whatever it changes.
 *
 * ⚠ AN ANSWER WITH NO READABLE USAGE SPENDS THE REST OF THE CAP. Nothing in the request
 * bounds its cost: an image or PDF by URL, a web search, a fetched page and a tool's
 * system prompt all bill input tokens the body does not show. So when an answered
 * request's `usage` is missing, partial or unreadable, the ledger charges the caller
 * whatever is left of its monthly cap, and the caller is refused until the month turns
 * over or its cap rises. The charge is in the ledger, so it survives a restart.
 *
 * ⚠ NO STREAMING YET. The ledger reads `usage` from a whole response. A streamed response
 * spreads it across events, and that parsing is not written.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../utils/index.js';
import type { Caller, GatewaySettings } from './config.js';
import { setLlmUsageSource } from '../metrics/index.js';
import { Ledger } from './ledger.js';
import { canonicalModel, costNanoUsd, priceFor, type Usage } from './pricing.js';

export const LLM_ROUTES = ['/v1/llm/v1/messages', '/v1/llm/messages'];

const UPSTREAM = 'https://api.anthropic.com/v1/messages';
const DEFAULT_VERSION = '2023-06-01';
/** Long enough for a large non-streaming answer; past it the caller gets a 504. */
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

/** Response headers the caller's SDK reads, passed back unchanged. */
const PASSTHROUGH_HEADERS = ['request-id', 'retry-after', 'anthropic-organization-id'];

/** At most this many open requests per caller, so concurrent answers cannot all cross the cap. */
export const MAX_IN_FLIGHT = 2;

/** The Messages API parameters the gateway forwards. Each bills at the rates in pricing.ts. */
const ALLOWED_PARAMS = new Set([
  'model',
  'max_tokens',
  'messages',
  'system',
  'stop_sequences',
  'temperature',
  'top_p',
  'top_k',
  'tools',
  'tool_choice',
  'metadata',
  'thinking',
  'output_config',
  'stream',
]);

const RequestSchema = z
  .object({
    model: z.string().min(1),
    max_tokens: z.number().int().positive(),
    stream: z.literal(false).optional(),
    tools: z
      .array(
        z
          .object({ type: z.string().optional() })
          .passthrough()
          // Code execution bills by container time, which pricing.ts does not price.
          .refine((t) => !t.type?.startsWith('code_execution'), 'code execution is not priced by the gateway'),
      )
      .optional(),
  })
  .passthrough()
  .superRefine((body, ctx) => {
    for (const key of Object.keys(body)) {
      if (!ALLOWED_PARAMS.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'is not a parameter the gateway can price' });
      }
    }
  });

export interface Gateway {
  readonly state: GatewaySettings['state'];
  /**
   * Refuse a request with no valid token before its body is read. The server mounts this
   * ahead of the 8 MB parser, so an unauthenticated caller never makes it parse 8 MB.
   */
  guard(req: Request, res: Response, next: NextFunction): void;
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

/**
 * The server's last error handler answers 500, which the SDK retries with the same body.
 * A body the parser refused (too large, or not JSON) fails the same way every time, so
 * the gateway's paths answer the parser's own 4xx in the API's error shape.
 */
export function gatewayErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== 'number' || status < 400 || status > 499) {
    next(err);
    return;
  }
  if (status === 413) refuse(res, 413, 'request_too_large', 'the request body is larger than the gateway accepts');
  else refuse(res, status, 'invalid_request_error', 'the request body could not be read as JSON');
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

/** A usage object the ledger can price: both required meters are numbers. */
function readableUsage(usage: unknown): Usage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Usage;
  return typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number' ? u : undefined;
}

/** A gateway that refuses everything, for the off and misconfigured states. */
function closedGateway(state: 'off' | 'misconfigured'): Gateway {
  const closed = (_req: Request, res: Response): void => refuse(res, 503, 'api_error', `the LLM gateway is ${state}`);
  return {
    state,
    guard: closed,
    async handle(req, res) {
      closed(req, res);
    },
    close() {},
  };
}

export function createGateway(settings: GatewaySettings, deps: GatewayDeps = {}): Gateway {
  if (settings.state !== 'on') {
    if (settings.state === 'misconfigured') {
      logger.error(`LLM gateway is misconfigured and will refuse every request: ${settings.reason}`);
    }
    return closedGateway(settings.state);
  }

  const { apiKey, callers } = settings;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());

  // An unwritable ledger path disables the gateway, not the bot (see config.ts).
  let ledger: Ledger;
  try {
    ledger = deps.ledger ?? new Ledger(settings.ledgerPath);
  } catch (err) {
    logger.error(
      `LLM gateway is misconfigured and will refuse every request: LLM_LEDGER_PATH cannot be opened: ${err instanceof Error ? err.message : String(err)}`,
    );
    return closedGateway('misconfigured');
  }

  // The scrape reads this month's totals from the same ledger the caps read (PET-711).
  setLlmUsageSource(() => ledger.monthTotals(now()));

  /**
   * Set when an answered request could not be recorded. Its cost is missing from the
   * ledger, so no cap can be trusted until a restart, and every later request gets a 503.
   */
  let ledgerBroken = false;
  const inFlight = new Map<string, number>();
  logger.info(`LLM gateway is on for ${callers.map((c) => c.name).join(', ')}`);

  function callerOf(req: Request): Caller | undefined {
    const presented = presentedToken(req);
    return presented ? findCaller(callers, presented) : undefined;
  }

  function guard(req: Request, res: Response, next: NextFunction): void {
    if (!callerOf(req)) {
      refuse(res, 401, 'authentication_error', 'unknown gateway token');
      return;
    }
    next();
  }

  async function handle(req: Request, res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller) {
      refuse(res, 401, 'authentication_error', 'unknown gateway token');
      return;
    }

    if (ledgerBroken) {
      refuse(res, 503, 'api_error', 'the LLM gateway ledger failed a write; restart pete-bot after fixing it');
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

    const open = inFlight.get(caller.name) ?? 0;
    if (open >= MAX_IN_FLIGHT) {
      res.setHeader('retry-after', '1');
      refuse(res, 429, 'rate_limit_error', `${caller.name} already has ${open} requests open`);
      return;
    }
    inFlight.set(caller.name, open + 1);
    try {
      await forward(req, res, caller, model);
    } finally {
      inFlight.set(caller.name, (inFlight.get(caller.name) ?? 1) - 1);
    }
  }

  async function forward(req: Request, res: Response, caller: Caller, model: string): Promise<void> {
    const body = JSON.stringify(req.body);
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
        body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      logger.error(`LLM gateway could not reach the API for ${caller.name}: ${err instanceof Error ? err.message : String(err)}`);
      refuse(res, timedOut ? 504 : 502, 'api_error', timedOut ? 'the API did not answer in time' : 'the API is unreachable');
      return;
    }

    const requestId = upstream.headers.get('request-id') ?? undefined;
    let text: string;
    try {
      text = await upstream.text();
    } catch (err) {
      // The API may have answered, and spent the tokens, before the body broke off.
      logger.error(`LLM gateway lost the API's answer for ${caller.name}: ${err instanceof Error ? err.message : String(err)}`);
      if (upstream.ok) recordUsage(caller, model, undefined, requestId);
      refuse(res, 502, 'api_error', 'the API answer was cut off');
      return;
    }

    if (upstream.ok) {
      recordUsage(caller, model, text, requestId);
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
   * Price and record one answered request. An answer with no readable `usage` is charged
   * the rest of the caller's monthly cap, because nothing bounds what it cost. The header
   * says why.
   *
   * A failed write is logged and the answer still goes back: the tokens are spent either
   * way, and a 5xx would make the SDK retry and spend them again. The failure latches
   * ledgerBroken, so the next request is refused instead of spending past an unknown total.
   */
  function recordUsage(caller: Caller, requested: string, text: string | undefined, requestId?: string): void {
    try {
      const at = now();
      let parsed: { model?: unknown; usage?: unknown } = {};
      try {
        parsed = text === undefined ? {} : (JSON.parse(text) as typeof parsed);
      } catch {
        // Fall through: an answer that is not JSON has no readable usage.
      }
      const model = typeof parsed.model === 'string' && priceFor(parsed.model) ? parsed.model : requested;
      const readable = readableUsage(parsed.usage);
      const usage: Usage = readable ?? {};
      const cost = readable
        ? costNanoUsd(priceFor(model)!, readable)
        : Math.max(caller.capNanoUsd - ledger.spentNanoUsd(caller.name, at), 0);
      if (!readable) {
        logger.warn(
          `LLM gateway: ${caller.name} got an answer with no readable usage, so it is charged the rest of its cap (${usd(cost)}) and refused until the month turns over`,
        );
      }
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
        at,
      );
      // Who, what and how much. Never the prompt or the answer.
      logger.info(`LLM gateway: ${caller.name} ${model} in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0} cost=${usd(cost)}`);
    } catch (err) {
      ledgerBroken = true;
      logger.error(
        `LLM gateway answered ${caller.name} but could not record the cost, so it refuses every request until a restart: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    state: 'on',
    guard,
    handle,
    close: () => {
      setLlmUsageSource(null);
      ledger.close();
    },
  };
}
