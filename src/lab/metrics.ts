/**
 * Routing metrics for the media assistant (Pedro, 2026-11-12: "see if too many tools make it
 * start acting up").
 *
 * Every series carries a `toolkits` label (the kits switched on, joined with +) and a `tools` label, the number of tools the model was offered, so one
 * query compares routing at 10 tools with routing at 13. A tool added later shows as a new
 * `tools` value.
 *
 * ⚠ WHAT THESE CAN AND CANNOT SAY. They count what the model did, not whether it was right.
 * `no_tool` is a proxy for a skipped read (a question that needed none counts too), and a
 * wrong tool that succeeds looks healthy here. The wrong-tool rate needs a labelled question
 * set: `scripts/media-routing-eval.ts` runs one and prints it against the same tool count.
 */
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { AskResult } from './agent.js';

export function createLabMetrics(toolkits = 'all') {
  const register = new Registry();
  // Which kits were on, so two runs with the same tool count but different kits stay apart.
  register.setDefaultLabels({ toolkits });
  const labels = ['tools'];

  const asks = new Counter({ name: 'lab_agent_media_asks_total', help: 'Media questions, by outcome and tools offered', labelNames: ['outcome', ...labels], registers: [register] });
  const noTool = new Counter({ name: 'lab_agent_media_no_tool_total', help: 'Answered questions that called no tool', labelNames: labels, registers: [register] });
  const calls = new Counter({ name: 'lab_agent_media_tool_calls_total', help: 'Tool calls, by tool and result', labelNames: ['tool', 'result', ...labels], registers: [register] });
  const invalid = new Counter({ name: 'lab_agent_media_invalid_input_total', help: 'Tool calls refused for bad arguments', labelNames: ['tool', ...labels], registers: [register] });
  const retries = new Counter({ name: 'lab_agent_media_retries_total', help: 'A tool called again right after it failed', labelNames: labels, registers: [register] });
  const turns = new Histogram({ name: 'lab_agent_media_turns', help: 'Model turns per question', labelNames: labels, buckets: [1, 2, 3, 4, 5, 6, 8], registers: [register] });
  const offered = new Gauge({ name: 'lab_agent_media_tools_offered', help: 'Tools offered to the model', registers: [register] });

  return {
    register,
    setToolsOffered: (n: number) => offered.set(n),
    /** Record one finished media question. Returns the derived fields for the journal line. */
    recordAsk(result: AskResult, offered: readonly string[]): { retries: number; noTool: boolean } {
      const t = String(offered.length);
      // A name the model invented is one `unknown` series, so garbage cannot grow the label set.
      const known = (n: string) => (offered.includes(n) ? n : 'unknown');
      asks.inc({ outcome: result.incomplete ? 'incomplete' : 'answered', tools: t });
      turns.observe({ tools: t }, result.turns);
      let retried = 0;
      result.toolCalls.forEach((c, i) => {
        calls.inc({ tool: known(c.name), result: c.ok ? 'ok' : 'error', tools: t });
        const prev = result.toolCalls[i - 1];
        if (prev && !prev.ok && prev.name === c.name) {
          retried++;
          retries.inc({ tools: t });
        }
      });
      for (const e of result.toolErrors ?? []) if (/invalid input/.test(e.error)) invalid.inc({ tool: known(e.name), tools: t });
      const none = result.toolCalls.length === 0;
      if (none) noTool.inc({ tools: t });
      return { retries: retried, noTool: none };
    },
    recordFailure(toolsOffered: number) {
      asks.inc({ outcome: 'failed', tools: String(toolsOffered) });
    },
  };
}

export type LabMetrics = ReturnType<typeof createLabMetrics>;

/**
 * The scrape door: its own listener on the LAN address, answering GET /metrics to one peer
 * (Prometheus on 240) and nothing else. Any other source gets 403 and any other path 404, so
 * the route on the loopback server stays the only wider surface. Counts and tool names only.
 */
export function createMetricsHandler(deps: { metrics: LabMetrics; allowedPeer: string; log?: (msg: string, fields?: Record<string, unknown>) => void }) {
  return async (req: Request, peer: string | undefined): Promise<Response> => {
    const source = (peer ?? '').replace(/^::ffff:/, '');
    if (source !== deps.allowedPeer) {
      deps.log?.('metrics refused', { source: source || 'unknown' });
      return new Response('forbidden', { status: 403 });
    }
    if (req.method !== 'GET' || new URL(req.url).pathname !== '/metrics') return new Response('not found', { status: 404 });
    return new Response(await deps.metrics.register.metrics(), { headers: { 'content-type': deps.metrics.register.contentType } });
  };
}
