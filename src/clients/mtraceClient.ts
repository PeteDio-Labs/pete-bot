/**
 * mtrace client — the only thing this app knows how to ask.
 *
 * mtrace (PET-355) runs beside this process on media-dash-237 and owns everything
 * about answering: the tool set, the Ollama routing, and the deterministic keyword
 * router it falls back to when the model is unreachable. This app does not
 * reimplement any of it, and must not: a second router would drift from the first,
 * and the CLI and Discord would start disagreeing about the same stack.
 *
 * ⚠ THE DTO IS MIRRORED BY HAND ACROSS TWO REPOS and nothing type-checks the seam.
 * That is the PET-89 shape, so the shapes below are asserted in mtraceClient.test.ts
 * rather than trusted.
 */
import { config } from '../config.js';

export interface AskResult {
  text: string;
  routedBy?: string;
  /** Split by mtrace, not summed: a slow route and a slow tool have different causes. */
  timing?: { routeMs?: number; toolMs?: number; totalMs?: number };
  /** Set when mtrace answered in a degraded mode, e.g. Ollama unreachable. */
  notice?: string;
}

export interface HealthResult {
  reachable: boolean;
  service?: string;
  model?: string;
  ollama?: string;
  authRequired?: boolean;
  detail?: string;
}

interface AskEnvelope {
  ok?: boolean;
  error?: string;
  result?: { text?: string; via?: string; timing?: AskResult['timing']; notice?: string };
  text?: string;
  via?: string;
  timing?: AskResult['timing'];
  notice?: string;
}

export async function ask(question: string): Promise<AskResult> {
  const res = await fetch(`${config.mtrace.url}/api/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.mtrace.token}`,
    },
    body: JSON.stringify({ question }),
    // ⚠ fetch has NO default timeout. mtrace's own transport learned this the hard
    // way: a host that answers its handshake and then stalls hangs the caller
    // forever. Bound it here too.
    signal: AbortSignal.timeout(config.mtrace.timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`mtrace returned ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as AskEnvelope;

  // ⚠ A TOOL FAILURE ARRIVES AS HTTP 200 WITH ok:false, AND THAT IS DELIBERATE.
  // mtrace reserves 5xx for its own process failing and answers "sonarr is not
  // answering" as a 200 finding, because planned downtime is normal in this stack and a
  // UI that renders it as a transport error tells the operator the dashboard is broken
  // when the dashboard is the only thing working. Reading only `text` turned every one
  // of those findings into "mtrace returned no text", which is that exact lie.
  if (data.ok === false) {
    throw new Error(data.error ?? 'mtrace reported a failure with no reason');
  }

  const inner = data.result ?? data;
  const text = inner.text;
  if (!text) throw new Error('mtrace returned no text');
  return { text, routedBy: inner.via, timing: inner.timing, notice: inner.notice };
}

/**
 * Liveness for /status. mtrace's /health never authenticates and never touches the
 * media stack — it answers "is this process up", not "is the lab healthy" — so this
 * sends no bearer and reports unreachable rather than throwing.
 */
export async function health(): Promise<HealthResult> {
  try {
    const res = await fetch(`${config.mtrace.url}/health`, {
      signal: AbortSignal.timeout(Math.min(config.mtrace.timeoutMs, 5_000)),
    });
    if (!res.ok) return { reachable: false, detail: `HTTP ${res.status}` };

    const body = (await res.json()) as Omit<HealthResult, 'reachable' | 'detail'>;
    return {
      reachable: true,
      service: body.service,
      model: body.model,
      ollama: body.ollama,
      authRequired: body.authRequired,
    };
  } catch (err) {
    return { reachable: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
