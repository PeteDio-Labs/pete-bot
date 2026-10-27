/**
 * The lab-map agent's loop (PET-669): one question in, one answer out, through a CallModel.
 *
 * It sends the question with the lab tools, runs each tool the model asks for through
 * callTool, and returns the model's final text. The model is the local Qwen on Ollama
 * (PET-742), which spends no API credit.
 *
 * ⚠ HARD LIMITS, NOT SUGGESTIONS. At most MAX_TURNS model calls, MAX_TOKENS output tokens
 * per call, and one deadline for the whole answer. The last turn offers no tools
 * (`tool_choice: none`), so the model answers from what it has read. An answer that hit a
 * limit, was cut at max_tokens, or came back empty is marked `incomplete`, never passed off
 * as a complete answer.
 *
 * ⚠ THE DEADLINE MUST BEAT THE CALLER'S. pete-bot gives up on /lab after LAB_TIMEOUT_MS
 * (120 s). A loop still running after that spends Ollama's one GPU lane on an answer nobody reads
 * and holds the one-question slot, so the server passes ASK_DEADLINE_MS (80 s) and the
 * request's own abort signal, and each model call gets only the time left. Tool reads run
 * to their own timeouts, so the deadline leaves room for one turn of them.
 *
 * ⚠ A TOOL ERROR REACHES THE MODEL AS AN ERROR. callTool's `{ ok: false }` becomes a
 * tool_result with `is_error: true`, and the prompt tells the model to say what failed.
 * Otherwise a dead Proxmox token reads to the model as "no guests" and to Pedro as an
 * empty lab.
 *
 * WHY NO SDK. The loop keeps the Messages shape, and ollama.ts translates it. One POST and
 * four response fields need only native fetch, so the dependency list stays as it is.
 */
import { callTool, type LabTool } from './tools/index.js';
import { toolDefinitions } from './tools/index.js';

export const MAX_TURNS = 8;
export const MAX_TOKENS = 1024;
// The deadline is checked between turns, and one turn's reads can take about 30 s more
// (each tool has its own timeout), so it sits well inside pete-bot's 120 s wait.
export const ASK_DEADLINE_MS = 80_000;

export const SYSTEM_PROMPT = `You answer questions about Pedro's homelab: where a service runs, whether it is up, what changed, and which PET work item touched it.

Rules:
- Use the tools. Never answer a lab fact from memory.
- Live state (pve_guests, pve_guest, kuma_status) outranks the knowledge vault (find_host, host_note). When they disagree, say so.
- To name PET items, call plane_item once with every key you found, never one call per key.
- Name your sources: the VMID, the vault note, the commit and the PET key.
- When a tool returns an error, say which read failed and why. Never treat a failed read as "nothing found".
- Answer in at most 8 short lines, for a phone screen. No preamble.`;

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface ModelResponse {
  content: ContentBlock[];
  stop_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}

export type CallModel = (body: Record<string, unknown>, signal?: AbortSignal) => Promise<ModelResponse>;

export interface AskResult {
  answer: string;
  turns: number;
  toolCalls: Array<{ name: string; ok: boolean }>;
  /** Set when the answer hit a limit, was cut, or came back empty: it is not a full answer. */
  incomplete: boolean;
  usage: { input: number; output: number; cacheRead: number };
}

export async function ask(
  question: string,
  tools: Map<string, LabTool>,
  callModel: CallModel,
  model: string,
  signal?: AbortSignal,
): Promise<AskResult> {
  const definitions = toolDefinitions(tools);
  // Cache the stable prefix: the system prompt and the tool list. Below the model's minimum
  // cacheable length this costs nothing and caches nothing; the ledger row shows which.
  const toolsParam = definitions.map((d, i) =>
    i === definitions.length - 1 ? { ...d, cache_control: { type: 'ephemeral' } } : d,
  );
  const system = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content: question }];
  const toolCalls: AskResult['toolCalls'] = [];
  const usage = { input: 0, output: 0, cacheRead: 0 };

  const stopped = (turns: number, why: string): AskResult => ({
    answer: `${why} Tools called: ${toolCalls.map((t) => `${t.name}${t.ok ? '' : ' (failed)'}`).join(', ') || 'none'}.`,
    turns,
    toolCalls,
    incomplete: true,
    usage,
  });

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (signal?.aborted) return stopped(turn - 1, 'I stopped before a final answer: the deadline passed.');
    const last = turn === MAX_TURNS;
    let res: ModelResponse;
    try {
      res = await callModel(
        { model, max_tokens: MAX_TOKENS, system, tools: toolsParam, messages, ...(last ? { tool_choice: { type: 'none' } } : {}) },
        signal,
      );
    } catch (err) {
      if (signal?.aborted) return stopped(turn - 1, 'I stopped before a final answer: the deadline passed.');
      throw err;
    }
    usage.input += num(res.usage?.input_tokens);
    usage.output += num(res.usage?.output_tokens);
    usage.cacheRead += num(res.usage?.cache_read_input_tokens);
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
    const uses = res.content.filter((b) => b.type === 'tool_use');

    if (res.stop_reason !== 'tool_use' || uses.length === 0) {
      const note =
        res.stop_reason === 'max_tokens' ? '\n\n(Answer cut at the output limit.)'
        : res.stop_reason === 'refusal' ? '\n\n(The model refused to answer.)'
        : '';
      const incomplete = Boolean(note) || !text;
      return { answer: (text || '(The model returned no text.)') + note, turns: turn, toolCalls, incomplete, usage };
    }
    if (last) {
      // tool_choice none should prevent this; if the model still asks, it gets no more reads.
      return stopped(turn, `I stopped after ${MAX_TURNS} model turns without a final answer.${text ? ` Last note: ${text}` : ''}`);
    }

    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const use of uses) {
      const tool = tools.get(use.name ?? '');
      const result = tool
        ? await callTool(tool, use.input)
        : ({ ok: false, error: `no tool named ${use.name}` } as const);
      toolCalls.push({ name: use.name ?? '?', ok: result.ok });
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: result.ok ? result.text : result.error,
        ...(result.ok ? {} : { is_error: true }),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  return stopped(MAX_TURNS, `I stopped after ${MAX_TURNS} model turns without a final answer.`);
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
