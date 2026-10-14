/**
 * The gateway's settings, checked once at startup (PET-617).
 *
 * THREE STATES, AND ONLY ONE FORWARDS ANYTHING.
 *
 *   off            ANTHROPIC_API_KEY is empty. Pedro has not seeded a key yet, so the
 *                  route answers 503 and the rest of the bot runs as before.
 *   misconfigured  A key is set, but a guard setting is missing or malformed. The route
 *                  answers 503, and /health reports it so a deploy check can fail on it.
 *   on             Every check below passed.
 *
 * ⚠ A BAD SETTING DISABLES THE GATEWAY, NOT THE BOT. The bun-app rule is to refuse to
 * serve on a bad guard setting. Here the guarded thing is the gateway, so the gateway
 * refuses. Throwing at startup would also stop Uptime Kuma's alerts, which is the job
 * this process exists for.
 *
 * LLM_GATEWAY_CALLERS is a JSON object of caller name to settings:
 *
 *   {"pm-agent": {"token": "<48+ random chars>", "monthlyCapUsd": 15,
 *                 "models": ["claude-haiku-4-5"]}}
 *
 * Each caller has its own bearer, its own monthly cap in whole dollars, and the models it
 * may ask for. A caller's spend never counts against another's cap.
 */
import { z } from 'zod';
import { PRICES } from './pricing.js';

export interface Caller {
  name: string;
  token: string;
  capNanoUsd: number;
  models: ReadonlySet<string>;
}

export type GatewaySettings =
  | { state: 'off' }
  | { state: 'misconfigured'; reason: string }
  | { state: 'on'; apiKey: string; callers: Caller[]; ledgerPath: string };

export interface GatewayEnv {
  apiKey: string;
  callersJson: string;
  ledgerPath: string;
  /** Tokens that open other routes. A caller token must not equal any of them. */
  otherTokens: string[];
}

/** 32 base64 characters carry 192 bits. Anything shorter was not minted by the seed script. */
const MIN_TOKEN_LENGTH = 32;

const CallerSchema = z
  .object({
    token: z.string().min(MIN_TOKEN_LENGTH).regex(/^\S+$/, 'must not contain whitespace'),
    monthlyCapUsd: z.number().int().min(1).max(1000),
    models: z
      .array(z.string().refine((m) => Object.hasOwn(PRICES, m), 'is not in the price table'))
      .min(1),
  })
  .strict();

const CallersSchema = z.record(z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'is not a caller name'), CallerSchema);

const misconfigured = (reason: string): GatewaySettings => ({ state: 'misconfigured', reason });

export function parseGatewaySettings(env: GatewayEnv): GatewaySettings {
  if (!env.apiKey.trim()) return { state: 'off' };

  if (!env.ledgerPath.trim()) {
    return misconfigured('LLM_LEDGER_PATH is empty, so every cap would reset on restart');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(env.callersJson);
  } catch {
    return misconfigured('LLM_GATEWAY_CALLERS is not valid JSON');
  }

  const parsed = CallersSchema.safeParse(raw);
  if (!parsed.success) {
    // Name the field and the rule. Never echo a value: one of them is a token.
    const issue = parsed.error.issues[0];
    return misconfigured(`LLM_GATEWAY_CALLERS.${issue?.path.join('.') ?? ''} ${issue?.message ?? 'is invalid'}`);
  }

  const entries = Object.entries(parsed.data);
  if (entries.length === 0) return misconfigured('LLM_GATEWAY_CALLERS names no caller');

  const seen = new Set<string>(env.otherTokens.filter(Boolean));
  for (const [name, c] of entries) {
    if (seen.has(c.token)) {
      return misconfigured(`LLM_GATEWAY_CALLERS.${name}.token is shared with another caller or route`);
    }
    seen.add(c.token);
  }

  return {
    state: 'on',
    apiKey: env.apiKey.trim(),
    ledgerPath: env.ledgerPath.trim(),
    callers: entries.map(([name, c]) => ({
      name,
      token: c.token,
      capNanoUsd: c.monthlyCapUsd * 1e9,
      models: new Set(c.models),
    })),
  };
}
