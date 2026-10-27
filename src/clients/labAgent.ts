/**
 * pete-bot's client for lab-agent (PET-669). /lab posts the question to lab-agent's
 * /v1/ask on 127.0.0.1 with the ask bearer and relays what comes back.
 *
 * ⚠ ONLY THE ASK BEARER CROSSES. lab-agent holds its own read credentials and its own
 * model access; pete-bot sends a question and nothing else.
 */
export interface LabAnswer {
  answer: string;
  turns: number;
  toolCalls: Array<{ name: string; ok: boolean }>;
  /** The answer hit a limit, was cut, or came back empty. */
  incomplete: boolean;
  usage: { input: number; output: number; cacheRead: number };
}

export type LabOutcome = { kind: 'answer'; result: LabAnswer } | { kind: 'not-configured' } | { kind: 'failed'; reason: string };

export interface LabClientConfig {
  url: string;
  token: string;
  timeoutMs: number;
}

export async function askLab(question: string, cfg: LabClientConfig, fetchImpl: typeof fetch = fetch): Promise<LabOutcome> {
  if (!cfg.token) return { kind: 'not-configured' };
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url.replace(/\/$/, '')}/v1/ask`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    const why = e?.name === 'TimeoutError' ? `no answer within ${Math.round(cfg.timeoutMs / 1000)}s` : `lab-agent unreachable (${e?.message ?? e})`;
    return { kind: 'failed', reason: why };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'failed', reason: `lab-agent answered HTTP ${res.status} with a body that is not JSON` };
  }
  if (!res.ok) {
    const error = (body as { error?: unknown })?.error;
    return { kind: 'failed', reason: `lab-agent answered HTTP ${res.status}: ${typeof error === 'string' ? error : 'no reason given'}` };
  }
  const answer = body as Partial<LabAnswer>;
  if (typeof answer.answer !== 'string') return { kind: 'failed', reason: 'lab-agent answered without an answer field' };
  return {
    kind: 'answer',
    result: {
      answer: answer.answer,
      turns: Number(answer.turns ?? 0),
      toolCalls: Array.isArray(answer.toolCalls) ? answer.toolCalls : [],
      incomplete: Boolean(answer.incomplete),
      usage: { input: num(answer.usage?.input), output: num(answer.usage?.output), cacheRead: num(answer.usage?.cacheRead) },
    },
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
