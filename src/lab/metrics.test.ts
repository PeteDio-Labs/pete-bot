import { describe, expect, it } from 'bun:test';
import { createLabMetrics, createMetricsHandler } from './metrics.js';
import type { AskResult } from './agent.js';

const result = (over: Partial<AskResult>): AskResult => ({ answer: 'x', turns: 2, toolCalls: [], toolErrors: [], proposals: [], incomplete: false, usage: { input: 0, output: 0, cacheRead: 0 }, ...over }) as AskResult;

describe('lab routing metrics', () => {
  it('labels every series with the tool count and counts retries, invalid input and no-tool answers', async () => {
    const m = createLabMetrics();
    m.setToolsOffered(13);
    const a = m.recordAsk(
      result({ toolCalls: [{ name: 'list_queue', ok: false }, { name: 'list_queue', ok: true }], toolErrors: [{ name: 'list_queue', error: "list_queue: invalid input: input: Unrecognized key(s) in object: 'title'" }] }),
      Array.from({ length: 13 }, (_, i) => (i === 0 ? 'list_queue' : `t${i}`)),
    );
    expect(a).toEqual({ retries: 1, noTool: false });
    expect(m.recordAsk(result({}), Array.from({ length: 13 }, (_, i) => `t${i}`))).toEqual({ retries: 0, noTool: true });
    m.recordAsk(result({ toolCalls: [{ name: 'made_up_tool', ok: false }], toolErrors: [] }), Array.from({ length: 13 }, (_, i) => `t${i}`));
    m.recordFailure(13);
    const text = await m.register.metrics();
    expect(text).toContain('lab_agent_media_tools_offered{toolkits="all"} 13');
    expect(text).toContain('lab_agent_media_retries_total{tools="13",toolkits="all"} 1');
    expect(text).toContain('lab_agent_media_no_tool_total{tools="13",toolkits="all"} 1');
    expect(text).toContain('lab_agent_media_invalid_input_total{tool="list_queue",tools="13",toolkits="all"} 1');
    expect(text).toContain('lab_agent_media_tool_calls_total{tool="list_queue",result="error",tools="13",toolkits="all"} 1');
    expect(text).toContain('tool="unknown"');
    expect(text).not.toContain('made_up_tool');
    expect(text).toContain('lab_agent_media_asks_total{outcome="failed",tools="13",toolkits="all"} 1');
  });

  it('serves /metrics to the one allowed peer and nothing else', async () => {
    const handler = createMetricsHandler({ metrics: createLabMetrics('core'), allowedPeer: '192.168.50.240' });
    const get = (path: string, peer: string | undefined, method = 'GET') => handler(new Request(`http://192.168.50.237:3019${path}`, { method }), peer);
    const ok = await get('/metrics', '::ffff:192.168.50.240');
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('toolkits="core"');
    expect((await get('/metrics', '192.168.50.10')).status).toBe(403);
    expect((await get('/metrics', undefined)).status).toBe(403);
    expect((await get('/health', '192.168.50.240')).status).toBe(404);
    expect((await get('/metrics', '192.168.50.240', 'POST')).status).toBe(404);
  });
});
