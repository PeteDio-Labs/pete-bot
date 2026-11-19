/**
 * The process-wide gateway, built once from the environment. Ollama is always on (the LAN
 * default). Haiku turns on only when ANTHROPIC_API_KEY is set; the key comes from Vault at
 * deploy time and is never logged. Prices are USD per million tokens and come from env so a
 * price change is a config change: verify them against Anthropic's pricing page before trusting the budget.
 */
import { Gateway } from './gateway.js';
import { Tracker } from './tracker.js';
import { haikuProvider, ollamaProvider } from './providers.js';

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : d;
};

let rt: { gateway: Gateway; tracker: Tracker } | null = null;

export function getLlm(env: NodeJS.ProcessEnv = process.env): { gateway: Gateway; tracker: Tracker } {
  if (rt) return rt;
  const tracker = new Tracker({ lokiUrl: env.LLM_LOKI_URL || undefined });
  const providers: ConstructorParameters<typeof Gateway>[0]['providers'] = {
    ollama: {
      model: env.LLM_OLLAMA_MODEL || 'qwen3:8b',
      call: ollamaProvider(env.LLM_OLLAMA_URL || 'http://192.168.50.246:11434', env.LLM_OLLAMA_MODEL || 'qwen3:8b'),
      concurrency: 1,
      usdPerMTokIn: 0,
      usdPerMTokOut: 0,
      timeoutMs: num(env.LLM_OLLAMA_TIMEOUT_MS, 60_000),
    },
  };
  if (env.ANTHROPIC_API_KEY) {
    const model = env.LLM_HAIKU_MODEL || 'claude-haiku-5-5';
    providers.haiku = {
      model,
      call: haikuProvider(env.ANTHROPIC_API_KEY, model),
      concurrency: 2,
      usdPerMTokIn: num(env.LLM_HAIKU_USD_PER_MTOK_IN, 1),
      usdPerMTokOut: num(env.LLM_HAIKU_USD_PER_MTOK_OUT, 5),
      timeoutMs: num(env.LLM_HAIKU_TIMEOUT_MS, 30_000),
    };
  }
  rt = { gateway: new Gateway({ providers, tracker, haikuMonthlyCapUsd: num(env.LLM_HAIKU_MONTHLY_CAP_USD, 100) }), tracker };
  return rt;
}
