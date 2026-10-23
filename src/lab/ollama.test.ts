import { describe, expect, it, mock } from 'bun:test';
import { ollamaCaller, toOllamaMessages, OllamaError } from './ollama.js';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('toOllamaMessages', () => {
  it('maps system, tool_use and tool_result, naming the tool on the result', () => {
    const out = toOllamaMessages([{ type: 'text', text: 'rules' }], [
      { role: 'user', content: 'where is plane' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'find_host', input: { query: 'plane' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'vmid 235', is_error: false }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_2', name: 'pve_guests', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'boom', is_error: true }] },
    ]);
    expect(out[0]).toEqual({ role: 'system', content: 'rules' });
    expect(out[2]).toEqual({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'find_host', arguments: { query: 'plane' } } }] });
    expect(out[3]).toEqual({ role: 'tool', content: 'vmid 235', tool_name: 'find_host' });
    expect(out[5]).toEqual({ role: 'tool', content: 'ERROR: boom', tool_name: 'pve_guests' });
  });
});

describe('ollamaCaller', () => {
  const body = {
    model: 'qwen3:8b',
    max_tokens: 1024,
    system: [{ type: 'text', text: 'rules' }],
    tools: [{ name: 'find_host', description: 'd', input_schema: { type: 'object' } }],
    messages: [{ role: 'user', content: 'q' }],
  };

  it('sends a non-streaming, non-thinking chat request and maps a tool call', async () => {
    const f = mock(async () => reply({ message: { content: '', tool_calls: [{ function: { name: 'find_host', arguments: { query: '235' } } }] }, prompt_eval_count: 90, eval_count: 12 }));
    const res = await ollamaCaller('http://o:11434', 8192, f as unknown as typeof fetch)(body);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://o:11434/api/chat');
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ model: 'qwen3:8b', stream: false, think: false, options: { num_ctx: 8192, num_predict: 1024 } });
    expect(sent.tools[0]).toEqual({ type: 'function', function: { name: 'find_host', description: 'd', parameters: { type: 'object' } } });
    expect(res.stop_reason).toBe('tool_use');
    expect(res.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'find_host', input: { query: '235' } }]);
    expect(res.usage).toEqual({ input_tokens: 90, output_tokens: 12 });
  });

  it('offers no tools when tool_choice is none, and maps length to max_tokens', async () => {
    const f = mock(async () => reply({ message: { content: 'cut' }, done_reason: 'length' }));
    const res = await ollamaCaller('http://o', 8192, f as unknown as typeof fetch)({ ...body, tool_choice: { type: 'none' } });
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)).tools).toBeUndefined();
    expect(res.stop_reason).toBe('max_tokens');
  });

  it('raises a named error for HTTP failures and unreachable hosts', async () => {
    const down = ollamaCaller('http://o', 8192, (async () => reply('no model', 404)) as unknown as typeof fetch);
    await expect(down(body)).rejects.toThrow('ollama answered HTTP 404');
    const dead = ollamaCaller('http://o', 8192, (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    await expect(dead(body)).rejects.toBeInstanceOf(OllamaError);
  });
});
