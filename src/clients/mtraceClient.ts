/**
 * mtrace client — the only thing this app knows how to ask.
 *
 * mtrace (PET-355) runs beside this process on media-dash-237 and owns everything
 * about answering: the tool set, the Ollama routing, and the deterministic keyword
 * router it falls back to when the model is unreachable. This app does not
 * reimplement any of it, and must not: a second router would drift from the first,
 * and the CLI and Discord would start disagreeing about the same stack.
 */
import { config } from '../config.js';

export interface AskResult {
  text: string;
  routedBy?: string;
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

  const data = (await res.json()) as { result?: { text?: string }; text?: string; routed_by?: string };
  const text = data.result?.text ?? data.text;
  if (!text) throw new Error('mtrace returned no text');
  return { text, routedBy: data.routed_by };
}
