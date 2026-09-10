/**
 * What Prometheus can actually answer about this process.
 *
 * ⚠ A DECLARED METRIC THAT NOTHING WRITES IS A LIE WITH A HELP STRING. This module used
 * to export eight, of which three were ever written: `discord_bot_messages_processed`,
 * `discord_bot_request_duration`, and four `..._sse_...` series named for an event stream
 * deleted with Mission Control. Scraping told you the bot was connected and nothing else,
 * so a working /ask and a completely broken one produced identical metrics. Every series
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
 * surface: 'ask' (slash command) or 'dm' (plain message).
 * status:  'success', 'failure' (mtrace did not answer), 'refused' (not the installer).
 */
export const askTotal = new Counter({
  name: 'pete_bot_ask_total',
  help: 'Questions forwarded to mtrace, by surface and outcome',
  labelNames: ['surface', 'status'],
  registers: [register],
});

export const askDuration = new Histogram({
  name: 'pete_bot_ask_duration_seconds',
  help: 'Time from question to rendered answer, by surface',
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

export const alertBatchesOpen = new Gauge({
  name: 'pete_bot_alert_batches_open',
  help: 'Incidents currently open, each one message in the owner DM',
  registers: [register],
});

export async function getMetrics(): Promise<string> {
  return register.metrics();
}

export function resetMetrics(): void {
  register.resetMetrics();
}
