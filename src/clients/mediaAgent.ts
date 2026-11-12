/**
 * pete-bot's client for the media assistant (PET-869). A DM from the owner goes to
 * lab-agent's POST /v1/media/ask with the ask bearer, plus the last few turns, and the
 * answer comes back as text.
 *
 * ⚠ ONLY THE ASK BEARER CROSSES, as with /lab. lab-agent holds the mtrace, Bazarr and
 * Plex credentials; pete-bot sends a question and its history and nothing else.
 */
import type { Proposal } from '../lab/tools/propose.js';

export interface MediaTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface MediaAnswer {
  answer: string;
  toolCalls: Array<{ name: string; ok: boolean }>;
  /** Changes the model proposed. None has run. */
  proposals: Proposal[];
  /** The answer hit a limit, was cut, or came back empty. */
  incomplete: boolean;
  /** Why each failed read failed, as lab-agent logged it. */
  toolErrors?: Array<{ name: string; error: string }>;
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
    result: {
      answer: a.answer,
      toolCalls: Array.isArray(a.toolCalls) ? a.toolCalls : [],
      proposals: parseProposals(a.proposals),
      incomplete: Boolean(a.incomplete),
      toolErrors: Array.isArray(a.toolErrors)
        ? a.toolErrors.filter((e) => typeof e?.name === 'string' && typeof e?.error === 'string')
        : [],
    },
  };
}

const TARGETS = ['plex', 'sonarr', 'radarr', 'prowlarr', 'bazarr', 'arr', 'plex-and-arr'];

/**
 * Keeps only proposals whose every field has the exact shape a button can act on. A
 * malformed one is dropped, never repaired: a button must do what its label says.
 */
export function parseProposals(raw: unknown): Proposal[] {
  if (!Array.isArray(raw)) return [];
  const out: Proposal[] = [];
  for (const p of raw as Array<Record<string, unknown>>) {
    if (out.length >= 3) break;
    const label = typeof p?.label === 'string' ? p.label.slice(0, 80) : '';
    if (!label) continue;
    if (p.action === 'subtitles' && (p.kind === 'series' || p.kind === 'movie') && Number.isInteger(p.id) && typeof p.title === 'string') {
      out.push({ action: 'subtitles', kind: p.kind, id: p.id as number, title: p.title.slice(0, 120), label, confirm: true });
    } else if ((p.action === 'update_check' || p.action === 'update_apply') && typeof p.target === 'string' && TARGETS.includes(p.target)) {
      const target = p.target as (typeof TARGETS)[number] as Extract<Proposal, { target: string }>['target'];
      out.push(p.action === 'update_check' ? { action: 'update_check', target, label, confirm: false } : { action: 'update_apply', target, label, confirm: true });
    }
  }
  return out;
}

export type ActOutcome = { kind: 'done'; message: string } | { kind: 'not-configured' } | { kind: 'failed'; reason: string };

/** Asks lab-agent to run the one confirmed write it holds, a Bazarr subtitle search. */
export async function actMedia(
  kind: 'series' | 'movie',
  id: number,
  cfg: MediaClientConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ActOutcome> {
  if (!cfg.token) return { kind: 'not-configured' };
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url.replace(/\/$/, '')}/v1/media/act`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind, id }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    return { kind: 'failed', reason: `lab-agent unreachable (${(err as Error)?.message ?? err})` };
  }
  let body: { ok?: unknown; message?: unknown; error?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { kind: 'failed', reason: `lab-agent answered HTTP ${res.status} with a body that is not JSON` };
  }
  if (res.ok && body.ok === true && typeof body.message === 'string') return { kind: 'done', message: body.message };
  return { kind: 'failed', reason: `lab-agent answered HTTP ${res.status}: ${typeof body.error === 'string' ? body.error : 'no reason given'}` };
}
