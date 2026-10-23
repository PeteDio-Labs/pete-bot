/**
 * What Prometheus can actually answer about this process.
 *
 * ⚠ A DECLARED METRIC THAT NOTHING WRITES IS A LIE WITH A HELP STRING. This module used
 * to export eight, of which three were ever written: `discord_bot_messages_processed`,
 * `discord_bot_request_duration`, and four `..._sse_...` series named for an event stream
 * deleted with Mission Control. Scraping told you the bot was connected and nothing else,
 * so a working command and a completely broken one produced identical metrics. Every series
 * below has a write site, and metrics/index.test.ts asserts the registry holds these and
 * only these — so the next dead metric fails a test instead of being scraped for months.
 */
import { Registry, Counter, Gauge, Histogram } from 'prom-client';

export const register = new Registry();

// ── Discord connection (written in main.ts) ───────────────────────────────────

export const discordBotUp = new Gauge({
  name: 'discord_bot_up',
  help: '1=connected to Discord, 0=disconnected',
  registers: [register],
});

export const discordWebsocketLatency = new Gauge({
  name: 'discord_bot_websocket_latency_seconds',
  help: 'Discord WebSocket ping latency in seconds',
  registers: [register],
});

// ── Answering (written in events/, PET-384) ───────────────────────────────────

/**
 * surface: 'update', or the refused command's name. It read 'ask' and 'dm' until PET-518
 * removed both; the series keeps its name so a dashboard query still resolves.
 * status:  'success', 'failure', 'refused' (not the installer).
 */
export const askTotal = new Counter({
  name: 'pete_bot_ask_total',
  help: 'Commands handled, by surface and outcome',
  labelNames: ['surface', 'status'],
  registers: [register],
});

export const askDuration = new Histogram({
  name: 'pete_bot_ask_duration_seconds',
  help: 'Time from command to rendered result, by surface',
  labelNames: ['surface'],
  // A deep trace crosses six hosts over SSH; the long buckets are the interesting ones.
  buckets: [0.5, 1, 2, 5, 10, 20, 40, 60],
  registers: [register],
});

// ── Alerting (written in server/routes/alert.ts) ──────────────────────────────

/** action: 'sent' or 'edited'. status: 'success' or 'failure'. */
export const alertDms = new Counter({
  name: 'pete_bot_alert_dms_total',
  help: 'Uptime Kuma alerts delivered to the owner DM, by action and outcome',
  labelNames: ['action', 'status'],
  registers: [register],
});

/** decision: held, released or deadline. outcome: pending, recovered, alerted, recovered_late or error. */
export const alertDecisions = new Counter({
  name: 'pete_bot_alert_decisions_total',
  help: 'Maintenance-window decisions for DOWN alerts (PET-492), by decision and outcome',
  labelNames: ['decision', 'outcome'],
  registers: [register],
});

export const alertBatchesOpen = new Gauge({
  name: 'pete_bot_alert_batches_open',
  help: 'Incidents currently open, each one message in the owner DM',
  registers: [register],
});

// ── LLM spend (read from the gateway ledger at scrape time, PET-711) ──────────

/** What a scrape reads: this month's totals per caller and model, or throws when the ledger cannot be read. */
export interface LlmMonthTotal {
  caller: string;
  model: string;
  costNanoUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

let llmUsageSource: (() => LlmMonthTotal[]) | null = null;

/** The gateway registers its ledger here when it opens one, and clears it on close. */
export function setLlmUsageSource(source: (() => LlmMonthTotal[]) | null): void {
  llmUsageSource = source;
}

/**
 * ⚠ ABSENT IS NOT ZERO. When the gateway is off or the ledger cannot be read, the spend series
 * are empty. This gauge says which: 1 means the ledger answered this scrape, 0 means the spend
 * series below hold nothing and must not be read as no spend.
 */
export const llmLedgerReadable = new Gauge({
  name: 'pete_bot_llm_ledger_readable',
  help: '1 when the gateway ledger answered this scrape, 0 when it is off or unreadable',
  registers: [register],
  collect() {
    this.set(readLedger() ? 1 : 0);
  },
});

/** The UTC month's spend per caller and model, in US dollars. Resets on the 1st with the caps. */
export const llmSpendUsdMonth = new Gauge({
  name: 'pete_bot_llm_spend_usd_month',
  help: 'LLM spend this UTC month in US dollars, by caller and model',
  labelNames: ['caller', 'model'],
  registers: [register],
  collect() {
    this.reset();
    for (const t of readLedger() ?? []) this.set({ caller: t.caller, model: t.model }, t.costNanoUsd / 1e9);
  },
});

/** kind: input, output, cache_read or cache_write. */
export const llmTokensMonth = new Gauge({
  name: 'pete_bot_llm_tokens_month',
  help: 'LLM tokens this UTC month, by caller, model and kind',
  labelNames: ['caller', 'model', 'kind'],
  registers: [register],
  collect() {
    this.reset();
    for (const t of readLedger() ?? []) {
      const base = { caller: t.caller, model: t.model };
      this.set({ ...base, kind: 'input' }, t.inputTokens);
      this.set({ ...base, kind: 'output' }, t.outputTokens);
      this.set({ ...base, kind: 'cache_read' }, t.cacheReadTokens);
      this.set({ ...base, kind: 'cache_write' }, t.cacheWriteTokens);
    }
  },
});

/** Null when there is no source or the read failed. A failed read is logged by the caller's metric, not thrown into the scrape. */
function readLedger(): LlmMonthTotal[] | null {
  if (!llmUsageSource) return null;
  try {
    return llmUsageSource();
  } catch {
    return null;
  }
}

export async function getMetrics(): Promise<string> {
  return register.metrics();
}

export function resetMetrics(): void {
  register.resetMetrics();
}
