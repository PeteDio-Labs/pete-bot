import { describe, it, expect, beforeEach } from 'vitest';
import {
  register,
  getMetrics,
  resetMetrics,
  discordBotUp,
  discordWebsocketLatency,
  askTotal,
  askDuration,
  alertDms,
  alertBatchesOpen,
} from './index.js';

beforeEach(() => resetMetrics());

describe('metrics', () => {
  it('exports in Prometheus format', async () => {
    discordBotUp.set(1);
    expect(await getMetrics()).toContain('# HELP');
  });

  it('reports the Discord connection', async () => {
    discordBotUp.set(1);
    discordWebsocketLatency.set(0.042);
    const dump = await getMetrics();
    expect(dump).toContain('discord_bot_up 1');
    expect(dump).toContain('discord_bot_websocket_latency_seconds 0.042');
  });

  it('separates a working surface from a broken one', async () => {
    askTotal.inc({ surface: 'ask', status: 'success' });
    askTotal.inc({ surface: 'dm', status: 'failure' });
    const dump = await getMetrics();
    expect(dump).toMatch(/pete_bot_ask_total\{surface="ask",status="success"\} 1/);
    expect(dump).toMatch(/pete_bot_ask_total\{surface="dm",status="failure"\} 1/);
  });

  it('times the answer by surface', async () => {
    askDuration.observe({ surface: 'ask' }, 6.8);
    expect(await getMetrics()).toMatch(/pete_bot_ask_duration_seconds_count\{surface="ask"\} 1/);
  });

  it('counts alert deliveries by what it did', async () => {
    alertDms.inc({ action: 'sent', status: 'success' });
    alertDms.inc({ action: 'edited', status: 'success' });
    const dump = await getMetrics();
    expect(dump).toMatch(/pete_bot_alert_dms_total\{action="sent",status="success"\} 1/);
    expect(dump).toMatch(/pete_bot_alert_dms_total\{action="edited",status="success"\} 1/);
  });

  it('reports how many incidents are open', async () => {
    alertBatchesOpen.set(3);
    expect(await getMetrics()).toContain('pete_bot_alert_batches_open 3');
  });

  /**
   * ⚠ THE POINT OF THIS FILE. Five metrics shipped for months with no write site,
   * describing an SSE layer that had been deleted. This asserts the registry holds
   * exactly the series the code writes, so the next dead metric fails here.
   */
  it('registers no metric that nothing writes', async () => {
    const names = (await register.getMetricsAsJSON()).map((m) => m.name).sort();
    expect(names).toEqual([
      'discord_bot_up',
      'discord_bot_websocket_latency_seconds',
      'pete_bot_alert_batches_open',
      'pete_bot_alert_dms_total',
      'pete_bot_ask_duration_seconds',
      'pete_bot_ask_total',
    ]);
  });
});
