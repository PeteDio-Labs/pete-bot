import { describe, expect, it } from 'bun:test';
import { createLabMetrics } from './metrics.js';
import type { AskResult } from './agent.js';

const result = (over: Partial<AskResult>): AskResult => ({ answer: 'x', turns: 2, toolCalls: [], toolErrors: [], proposals: [], incomplete: false, usage: { input: 0, output: 0, cacheRead: 0 }, ...over }) as AskResult;

describe('lab routing metrics', () => {
  it('labels every series with the tool count and counts retries, invalid input and no-tool answers', async () => {
    const m = createLabMetrics();
    m.setToolsOffered(13);
    const a = m.recordAsk(
      result({ toolCalls: [{ name: 'list_queue', ok: false }, { name: 'list_queue', ok: true }], toolErrors: [{ name: 'list_queue', error: "list_queue: invalid input: input: Unrecognized key(s) in object: 'title'" }] }),
      13,
    );
    expect(a).toEqual({ retries: 1, noTool: false });
    expect(m.recordAsk(result({}), 13)).toEqual({ retries: 0, noTool: true });
    m.recordFailure(13);
    const text = await m.register.metrics();
    expect(text).toContain('lab_agent_media_tools_offered 13');
    expect(text).toContain('lab_agent_media_retries_total{tools="13"} 1');
    expect(text).toContain('lab_agent_media_no_tool_total{tools="13"} 1');
    expect(text).toContain('lab_agent_media_invalid_input_total{tool="list_queue",tools="13"} 1');
    expect(text).toContain('lab_agent_media_tool_calls_total{tool="list_queue",result="error",tools="13"} 1');
    expect(text).toContain('lab_agent_media_asks_total{outcome="failed",tools="13"} 1');
  });
});
