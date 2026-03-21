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

// SSE Event Stream Metrics
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
  help: 'Total DM notifications sent from SSE events',
  labelNames: ['status'],
  registers: [register],
});

// Event Dedup Metrics
export const sseEventsDeduplicated = new Counter({
  name: 'discord_bot_sse_events_deduplicated_total',
  help: 'Total events suppressed by deduplication',
  labelNames: ['source', 'type'],
  registers: [register],
});

// Triage Metrics
export const triageInvestigationsRun = new Counter({
  name: 'discord_bot_triage_investigations_total',
  help: 'Total triage investigations executed',
  labelNames: ['source', 'type', 'result'],
  registers: [register],
});

export const triageInvestigationDuration = new Histogram({
  name: 'discord_bot_triage_investigation_duration_seconds',
  help: 'Triage investigation duration in seconds',
  labelNames: ['source', 'type'],
  buckets: [0.5, 1, 2, 5, 10],
  registers: [register],
});

// Remediation Metrics
export const remediationTasksTotal = new Counter({
  name: 'discord_bot_remediation_tasks_total',
  help: 'Total remediation tasks created',
  labelNames: ['action', 'state'],
  registers: [register],
});

// Health Poller Metrics
export const healthPollerRuns = new Counter({
  name: 'discord_bot_health_poller_runs_total',
  help: 'Total health poller execution cycles',
  labelNames: ['poller', 'result'],
  registers: [register],
});

export const healthPollerEventsPublished = new Counter({
  name: 'discord_bot_health_poller_events_published_total',
  help: 'Total events published by health poller',
  labelNames: ['poller', 'severity'],
  registers: [register],
});

// Web Search Service Metrics
export const wsRequestDuration = new Histogram({
  name: 'discord_bot_web_search_duration_seconds',
  help: 'Web search service request duration in seconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 15],
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
