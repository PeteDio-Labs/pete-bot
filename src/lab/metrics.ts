/**
 * Routing metrics for the media assistant (Pedro, 2026-11-12: "see if too many tools make it
 * start acting up").
 *
 * Every series carries a `tools` label, the number of tools the model was offered, so one
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

export function createLabMetrics() {
  const register = new Registry();
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
    recordAsk(result: AskResult, toolsOffered: number): { retries: number; noTool: boolean } {
      const t = String(toolsOffered);
      asks.inc({ outcome: result.incomplete ? 'incomplete' : 'answered', tools: t });
      turns.observe({ tools: t }, result.turns);
      let retried = 0;
      result.toolCalls.forEach((c, i) => {
        calls.inc({ tool: c.name, result: c.ok ? 'ok' : 'error', tools: t });
        const prev = result.toolCalls[i - 1];
        if (prev && !prev.ok && prev.name === c.name) {
          retried++;
          retries.inc({ tools: t });
        }
      });
      for (const e of result.toolErrors ?? []) if (/invalid input/.test(e.error)) invalid.inc({ tool: e.name, tools: t });
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
