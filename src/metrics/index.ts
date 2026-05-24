import { Registry, Counter, Gauge, Histogram } from 'prom-client';

export const register = new Registry();

// Discord Bot
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

export const discordMessagesProcessed = new Counter({
  name: 'discord_bot_messages_processed_total',
  help: 'Total interactions processed',
  labelNames: ['command', 'status'],
  registers: [register],
});

export const discordRequestDuration = new Histogram({
  name: 'discord_bot_request_duration_seconds',
  help: 'Command processing duration in seconds',
  labelNames: ['command'],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

// SSE Event Stream
export const sseEventsReceived = new Counter({
  name: 'discord_bot_sse_events_received_total',
  help: 'Total events received from SSE stream',
  labelNames: ['source', 'type', 'severity'],
  registers: [register],
});

export const sseConnected = new Gauge({
  name: 'discord_bot_sse_connected',
  help: '1=connected to SSE stream, 0=disconnected',
  registers: [register],
});

export const sseDmsSent = new Counter({
  name: 'discord_bot_sse_dms_sent_total',
  help: 'Total DM notifications sent',
  labelNames: ['status'],
  registers: [register],
});

export const sseEventsDeduplicated = new Counter({
  name: 'discord_bot_sse_events_deduplicated_total',
  help: 'Total events suppressed by deduplication',
  labelNames: ['source', 'type'],
  registers: [register],
});

// Plan Expiry Sweep (PB.8)
// outcome: 'edited' (success), 'no_cache' (cache miss — RETRO.23),
//          'discord_failed' (channel/message fetch or edit blew up),
//          'fetch_failed' (MC backend list call failed)
export const expirySweepProcessed = new Counter({
  name: 'discord_bot_expiry_sweep_processed_total',
  help: 'Plans handled by the PB.8 expiry sweep, by outcome',
  labelNames: ['outcome'],
  registers: [register],
});

export const expirySweepTicks = new Counter({
  name: 'discord_bot_expiry_sweep_ticks_total',
  help: 'Total ticks of the PB.8 expiry sweep timer',
  labelNames: ['status'],
  registers: [register],
});

export async function getMetrics(): Promise<string> {
  return register.metrics();
}

export function resetMetrics(): void {
  register.resetMetrics();
}
