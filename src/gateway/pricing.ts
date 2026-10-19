/**
 * What one Messages API response costs, in integer nano-dollars (PET-617).
 *
 * WHY NANO-DOLLARS. Haiku 4.5 reads its cache at $0.10 per million tokens, which is a
 * tenth of a micro-dollar per token. At one nano-dollar the smallest rate is still a
 * whole number, so the ledger stores and sums integers and never rounds. A $100 month is
 * 1e11 nano-dollars, well inside Number.MAX_SAFE_INTEGER.
 *
 * A $/MTok rate is the same number of micro-dollars per token, so each rate below is the
 * published $/MTok figure times 1000.
 *
 * ⚠ A MODEL MISSING HERE IS REFUSED, NOT PRICED AT ZERO. A cap is only as good as the
 * cost it adds up, so the gateway forwards a request only for a model it can price.
 * Add the model here, with its published rates, before a caller may use it.
 */

export interface ModelPrice {
  /** Nano-dollars per uncached input token. */
  input: number;
  /** Nano-dollars per output token. */
  output: number;
  /** Nano-dollars per cache-read token. */
  cacheRead: number;
  /** Nano-dollars per cache-write token, 5-minute TTL (1.25x input). */
  cacheWrite5m: number;
  /** Nano-dollars per cache-write token, 1-hour TTL (2x input). */
  cacheWrite1h: number;
}

const perMTok = (input: number, output: number, cacheRead: number): ModelPrice => ({
  input: input * 1000,
  output: output * 1000,
  cacheRead: Math.round(cacheRead * 1000),
  cacheWrite5m: Math.round(input * 1.25 * 1000),
  cacheWrite1h: input * 2 * 1000,
});

/**
 * Keyed by the alias a caller sends. Opus 5.5 and Sonnet 5.5 read their cache at 0.05x
 * input, not the usual 0.1x, so pass each cache-read rate as published.
 *
 * A response names the dated snapshot, such as
 * `claude-haiku-4-5-20251001`, so `priceFor` also matches an alias followed by a date.
 */
export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-4-5': perMTok(1, 5, 0.1),
  'claude-sonnet-5-5': perMTok(2, 10, 0.1),
  'claude-opus-5-5': perMTok(4, 20, 0.2),
};

/** $10 per 1,000 web searches. */
export const WEB_SEARCH_NANO_USD = 10_000_000;

/** The alias a model id prices under: itself, or the alias before a snapshot date. */
export function canonicalModel(model: string): string | undefined {
  if (Object.hasOwn(PRICES, model)) return model;
  const alias = /^(.*)-\d{8}$/.exec(model)?.[1];
  return alias !== undefined && Object.hasOwn(PRICES, alias) ? alias : undefined;
}

export function priceFor(model: string): ModelPrice | undefined {
  const alias = canonicalModel(model);
  return alias ? PRICES[alias] : undefined;
}

/** The `usage` object of a Messages API response. Every field may be absent or null. */
export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

const n = (v: number | null | undefined): number => (typeof v === 'number' && v > 0 ? v : 0);

/**
 * The cost of one response. When the TTL split is missing, every cache write is priced
 * at the 1-hour rate: the ledger may overcount, but it never undercounts.
 */
export function costNanoUsd(price: ModelPrice, usage: Usage): number {
  const split = usage.cache_creation;
  let write5m = 0;
  let write1h = 0;
  if (split && (split.ephemeral_5m_input_tokens != null || split.ephemeral_1h_input_tokens != null)) {
    write5m = n(split.ephemeral_5m_input_tokens);
    write1h = n(split.ephemeral_1h_input_tokens);
  } else {
    write1h = n(usage.cache_creation_input_tokens);
  }
  return (
    n(usage.input_tokens) * price.input +
    n(usage.output_tokens) * price.output +
    n(usage.cache_read_input_tokens) * price.cacheRead +
    write5m * price.cacheWrite5m +
    write1h * price.cacheWrite1h +
    n(usage.server_tool_use?.web_search_requests) * WEB_SEARCH_NANO_USD
  );
}
