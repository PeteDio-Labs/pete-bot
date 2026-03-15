import { Registry, Counter, Gauge, Histogram } from 'prom-client';

// Create a new registry
export const register = new Registry();

// Discord Bot Metrics
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

// Ollama Metrics
export const ollamaAvailable = new Gauge({
  name: 'ollama_available',
  help: '1=Ollama reachable, 0=unavailable',
  registers: [register],
});

export const ollamaRequestDuration = new Histogram({
  name: 'ollama_request_duration_seconds',
  help: 'AI request duration in seconds',
  buckets: [0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

// Tool Metrics
export const toolExecutionsTotal = new Counter({
  name: 'tool_executions_total',
  help: 'Tool executions',
  labelNames: ['tool', 'status'],
  registers: [register],
});

export const toolExecutionDuration = new Histogram({
  name: 'tool_execution_duration_seconds',
  help: 'Per-tool execution time in seconds',
  labelNames: ['tool'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [register],
});

// Mission Control Metrics
export const mcAvailable = new Gauge({
  name: 'mission_control_available',
  help: '1=Mission Control reachable, 0=unavailable',
  registers: [register],
});

export const mcRequestDuration = new Histogram({
  name: 'mission_control_request_duration_seconds',
  help: 'Mission Control API request duration in seconds',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

// qBittorrent Metrics
export const qbitAvailable = new Gauge({
  name: 'qbittorrent_available',
  help: '1=qBittorrent reachable, 0=unavailable',
  registers: [register],
});

export const qbitRequestDuration = new Histogram({
  name: 'qbittorrent_request_duration_seconds',
  help: 'qBittorrent API request duration in seconds',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

/**
 * Get all metrics in Prometheus format
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Reset all metrics (useful for testing)
 */
export function resetMetrics(): void {
  register.resetMetrics();
}
