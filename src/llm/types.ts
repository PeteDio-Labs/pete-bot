/** Shared shapes for the model queue and the call tracker (PET llm-gateway). */
export type Provider = 'ollama' | 'haiku';

export interface LlmRequest {
  /** Who asked: a stable name such as `triage`, `incident-explainer`, `lab-agent`. */
  caller: string;
  provider: Provider;
  system?: string;
  prompt: string;
  /** Caller's own id. The same id replays to the same audit record id, so a retry does not double count. */
  requestId?: string;
  /** Lower runs first. Alerts use 0, background jobs use 5. */
  priority?: number;
  maxTokens?: number;
}

export type CallResult = 'ok' | 'error' | 'timeout' | 'budget_blocked' | 'queue_full';

/** One audited call. Hashes stand in for the text: the audit never stores a prompt or a response. */
export interface CallRecord {
  id: string;
  at: string;
  caller: string;
  provider: Provider;
  model: string;
  promptHash: string;
  responseHash: string;
  promptChars: number;
  responseChars: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  queueMs: number;
  latencyMs: number;
  result: CallResult;
  error?: string;
}

export interface ProviderReply {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export type ProviderCall = (req: LlmRequest, signal: AbortSignal) => Promise<ProviderReply>;
