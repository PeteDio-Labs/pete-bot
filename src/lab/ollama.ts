/**
 * The Ollama provider for lab-agent (PET-742): the only CallModel, so
 * `ask` does not change. It takes the Anthropic Messages body `ask` builds, sends it to
 * Ollama's native /api/chat, and returns the reply in the Messages shape.
 *
 * WHY A TRANSLATOR AND NOT A SECOND LOOP. The tool loop, its limits and its deadline are
 * the parts that took work to get right (agent.ts). Only the wire format differs.
 *
 * ⚠ Ollama gives a tool call no id, so this mints one (`call_<n>`). The id only has to pair
 * a tool_use with its tool_result inside one `ask`; the result's tool name is found by
 * that id when the history is sent back.
 *
 * ⚠ `think: false`. A Qwen3 model that thinks spends the 1024-token output limit on
 * reasoning and returns an empty answer, which `ask` marks incomplete.
 */
import type { CallModel, ContentBlock, ModelResponse } from './agent.js';

const OLLAMA_TIMEOUT_MS = 60_000;

export class OllamaError extends Error {
  override name = 'OllamaError';
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  tool_name?: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[] | Array<Record<string, unknown>>;
}

/** Turn the Messages-shaped history into Ollama messages. Exported for tests. */
export function toOllamaMessages(system: unknown, messages: AnthropicMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  const sys = Array.isArray(system) ? system.map((b: { text?: string }) => b.text ?? '').join('\n') : typeof system === 'string' ? system : '';
  if (sys) out.push({ role: 'system', content: sys });
  const names = new Map<string, string>();
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = m.content as Array<Record<string, unknown>>;
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n');
      const calls = blocks.filter((b) => b.type === 'tool_use');
      for (const c of calls) names.set(String(c.id), String(c.name));
      out.push({
        role: 'assistant',
        content: text,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: String(c.name), arguments: c.input ?? {} } })) } : {}),
      });
    } else {
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const body = String(b.content ?? '');
          out.push({ role: 'tool', content: b.is_error ? `ERROR: ${body}` : body, tool_name: names.get(String(b.tool_use_id)) ?? 'unknown' });
        } else if (b.type === 'text') {
          out.push({ role: 'user', content: String(b.text ?? '') });
        }
      }
    }
  }
  return out;
}

/** POST one Messages-shaped request to Ollama's /api/chat. */
export function ollamaCaller(baseUrl: string, numCtx: number, fetchImpl: typeof fetch = fetch): CallModel {
  let seq = 0;
  return async (body, signal) => {
    const tools = body.tool_choice && (body.tool_choice as { type?: string }).type === 'none' ? [] : ((body.tools as Array<Record<string, unknown>>) ?? []);
    const payload = {
      model: body.model,
      stream: false,
      think: false,
      messages: toOllamaMessages(body.system, body.messages as AnthropicMessage[]),
      ...(tools.length
        ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) }
        : {}),
      options: { num_ctx: numCtx, num_predict: body.max_tokens, temperature: 0 },
    };
    const timeout = AbortSignal.timeout(OLLAMA_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) throw new OllamaError('stopped: the answer ran past its deadline or the asker went away');
      throw new OllamaError(`ollama unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new OllamaError(`ollama answered HTTP ${res.status}: ${text.slice(0, 300)}`);
    let data: {
      message?: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }> };
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    try {
      data = JSON.parse(text);
    } catch {
      throw new OllamaError('ollama answered with a body that is not JSON');
    }
    const content: ContentBlock[] = [];
    if (data.message?.content) content.push({ type: 'text', text: data.message.content });
    const calls = data.message?.tool_calls ?? [];
    for (const c of calls) content.push({ type: 'tool_use', id: `call_${++seq}`, name: c.function.name, input: c.function.arguments });
    const out: ModelResponse = {
      content,
      stop_reason: calls.length ? 'tool_use' : data.done_reason === 'length' ? 'max_tokens' : 'end_turn',
      usage: { input_tokens: data.prompt_eval_count ?? 0, output_tokens: data.eval_count ?? 0 },
    };
    return out;
  };
}
