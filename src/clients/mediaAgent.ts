/**
 * pete-bot's client for the media assistant (PET-869). A DM from the owner goes to
 * lab-agent's POST /v1/media/ask with the ask bearer, plus the last few turns, and the
 * answer comes back as text.
 *
 * ⚠ ONLY THE ASK BEARER CROSSES, as with /lab. lab-agent holds the mtrace, Bazarr and
 * Plex credentials; pete-bot sends a question and its history and nothing else.
 */
export interface MediaTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface MediaAnswer {
  answer: string;
  toolCalls: Array<{ name: string; ok: boolean }>;
  /** The answer hit a limit, was cut, or came back empty. */
  incomplete: boolean;
}

export type MediaOutcome = { kind: 'answer'; result: MediaAnswer } | { kind: 'not-configured' } | { kind: 'failed'; reason: string };

export interface MediaClientConfig {
  url: string;
  token: string;
  timeoutMs: number;
}

export async function askMedia(
  question: string,
  history: MediaTurn[],
  cfg: MediaClientConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<MediaOutcome> {
  if (!cfg.token) return { kind: 'not-configured' };
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url.replace(/\/$/, '')}/v1/media/ask`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question, history }),
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
  const a = body as Partial<MediaAnswer>;
  if (typeof a.answer !== 'string') return { kind: 'failed', reason: 'lab-agent answered without an answer field' };
  return {
    kind: 'answer',
    result: { answer: a.answer, toolCalls: Array.isArray(a.toolCalls) ? a.toolCalls : [], incomplete: Boolean(a.incomplete) },
  };
}
