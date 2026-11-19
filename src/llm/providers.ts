import type { ProviderCall } from './types.js';

/** Ollama /api/chat. `think:false`, because a thinking Qwen3 spends its output limit on reasoning (see lab/ollama.ts). */
export function ollamaProvider(baseUrl: string, model: string, fetchImpl: typeof fetch = fetch): ProviderCall {
  return async (req, signal) => {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        options: { num_predict: req.maxTokens ?? 512 },
        messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content: req.prompt }],
      }),
    });
    if (!res.ok) throw new Error(`ollama answered ${res.status}`);
    const j = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
    return { text: j.message?.content ?? '', tokensIn: j.prompt_eval_count ?? 0, tokensOut: j.eval_count ?? 0 };
  };
}

/** Anthropic Messages API for Haiku. The key is passed in at call time and never logged. */
export function haikuProvider(apiKey: string, model: string, fetchImpl: typeof fetch = fetch): ProviderCall {
  return async (req, signal) => {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 512,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content: req.prompt }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic answered ${res.status}`);
    const j = (await res.json()) as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    return { text, tokensIn: j.usage?.input_tokens ?? 0, tokensOut: j.usage?.output_tokens ?? 0 };
  };
}
