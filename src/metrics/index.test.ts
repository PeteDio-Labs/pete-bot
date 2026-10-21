import { describe, it, expect, beforeEach } from 'bun:test';
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
  setLlmUsageSource,
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
    askTotal.inc({ surface: 'update', status: 'success' });
    askTotal.inc({ surface: 'status', status: 'refused' });
    const dump = await getMetrics();
    expect(dump).toMatch(/pete_bot_ask_total\{surface="update",status="success"\} 1/);
    expect(dump).toMatch(/pete_bot_ask_total\{surface="status",status="refused"\} 1/);
  });

  it('times the command by surface', async () => {
    askDuration.observe({ surface: 'update' }, 6.8);
    expect(await getMetrics()).toMatch(/pete_bot_ask_duration_seconds_count\{surface="update"\} 1/);
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

  it('reports spend and tokens from the ledger, in dollars', async () => {
    setLlmUsageSource(() => [
      { caller: 'lab-agent', model: 'claude-sonnet-5-5', costNanoUsd: 1_500_000_000, inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4 },
    ]);
    const dump = await getMetrics();
    setLlmUsageSource(null);
    expect(dump).toContain('pete_bot_llm_ledger_readable 1');
    expect(dump).toMatch(/pete_bot_llm_spend_usd_month\{caller="lab-agent",model="claude-sonnet-5-5"\} 1\.5/);
    expect(dump).toMatch(/pete_bot_llm_tokens_month\{caller="lab-agent",model="claude-sonnet-5-5",kind="cache_write"\} 4/);
  });

  it('says the ledger is unreadable instead of reporting zero spend', async () => {
    setLlmUsageSource(() => {
      throw new Error('disk gone');
    });
    const dump = await getMetrics();
    setLlmUsageSource(null);
    expect(dump).toContain('pete_bot_llm_ledger_readable 0');
    expect(dump).not.toMatch(/pete_bot_llm_spend_usd_month\{/);
  });

  it('says the ledger is unreadable when no gateway registered one', async () => {
    setLlmUsageSource(null);
    expect(await getMetrics()).toContain('pete_bot_llm_ledger_readable 0');
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
      'pete_bot_alert_decisions_total',
      'pete_bot_alert_dms_total',
      'pete_bot_ask_duration_seconds',
      'pete_bot_ask_total',
      'pete_bot_llm_ledger_readable',
      'pete_bot_llm_spend_usd_month',
      'pete_bot_llm_tokens_month',
    ]);
  });
});
