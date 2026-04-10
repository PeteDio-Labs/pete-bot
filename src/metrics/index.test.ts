import { describe, it, expect, beforeEach } from 'vitest';
import {
  getMetrics,
  discordBotUp,
  discordWebsocketLatency,
  discordMessagesProcessed,
  discordRequestDuration,
  sseEventsReceived,
  sseConnected,
  sseDmsSent,
  resetMetrics,
} from './index.js';

describe('Metrics Module', () => {
  beforeEach(() => {
    resetMetrics();
  });

  it('should export metrics in Prometheus format', async () => {
    const metrics = await getMetrics();
    expect(metrics).toContain('# HELP');
    expect(metrics).toContain('# TYPE');
  });

  it('should expose discord_bot_up gauge', async () => {
    discordBotUp.set(1);
    const metrics = await getMetrics();
    expect(metrics).toContain('discord_bot_up 1');
  });

  it('should expose websocket latency gauge', async () => {
    discordWebsocketLatency.set(0.045);
    const metrics = await getMetrics();
    expect(metrics).toContain('discord_bot_websocket_latency_seconds 0.045');
  });

  it('should track messages processed with labels', async () => {
    discordMessagesProcessed.labels('help', 'success').inc();
    const metrics = await getMetrics();
    expect(metrics).toContain('command="help"');
    expect(metrics).toContain('status="success"');
  });

  it('should track request duration histogram', async () => {
    discordRequestDuration.labels('help').observe(0.1);
    const metrics = await getMetrics();
    expect(metrics).toContain('discord_bot_request_duration_seconds');
  });

  it('should track SSE events received', async () => {
    sseEventsReceived.inc({ source: 'kubernetes', type: 'pod-failure', severity: 'critical' });
    const metrics = await getMetrics();
    expect(metrics).toContain('discord_bot_sse_events_received_total');
    expect(metrics).toContain('source="kubernetes"');
  });

  it('should track SSE connection state', async () => {
    sseConnected.set(1);
    const metrics = await getMetrics();
    expect(metrics).toContain('discord_bot_sse_connected 1');
  });

  it('should track DMs sent', async () => {
    sseDmsSent.inc({ status: 'success' });
    sseDmsSent.inc({ status: 'failure' });
    const metrics = await getMetrics();
    expect(metrics).toContain('discord_bot_sse_dms_sent_total');
  });
});
