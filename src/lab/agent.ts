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
import { PROPOSE_TOOL, type Proposal } from './tools/propose.js';

export const MAX_TURNS = 8;
/** A tool error longer than this is cut before it reaches the journal. */
const MAX_ERROR_CHARS = 300;
/** A tool call the model wrote into its answer text instead of making. */
const RAW_TOOL_CALL = /<tool_call>/i;
export const MAX_TOKENS = 1024;
// The deadline is checked between turns, and one turn's reads can take about 30 s more
// (each tool has its own timeout), so it sits well inside pete-bot's 120 s wait.
export const ASK_DEADLINE_MS = 80_000;

export const SYSTEM_PROMPT = `You answer questions about Pedro's homelab: where a service runs, whether it is up, what changed, and which PET work item touched it.

Rules:
- Use the tools. Never answer a lab fact from memory.
- Live state (pve_guests, pve_guest, kuma_status) outranks the knowledge vault (find_host, host_note). When they disagree, say so.
- For "what is broken right now", call lab_overview once before any detail tool.
- To name PET items, call plane_item once with every key you found, never one call per key.
- Name your sources: the VMID, the vault note, the commit and the PET key.
- When a tool returns an error, say which read failed and why. Never treat a failed read as "nothing found".
- Answer in at most 8 short lines, for a phone screen. No preamble.`;

/**
 * The media assistant's prompt (PET-869). The same loop and limits as /lab, a different
 * job: troubleshoot the media stack from mtrace's verdicts, in a chat.
 */
export const MEDIA_SYSTEM_PROMPT = `You are Pedro's media assistant. You answer in a Discord chat about Plex, Sonarr, Radarr, Prowlarr, qBittorrent, seerr and Bazarr.

Rules:
- Use the tools. Never state a media fact from memory.
- For a named title, call trace_request. For "is the VPN up" or when every download stalls, call vpn_health first.
- mtrace's verdict is the answer. Quote its cause and fix; do not invent a different cause.
- A named title or a follow-up about one ("are they downloading?", "is it coming?") is answered by trace_request for that title first, because it joins Sonarr, Radarr, the queue and seerr. Call list_queue as well only for progress, speed or ETA. An empty list_queue never proves a title is not wanted: say what trace_request found, and name what is and is not downloading.
- For "who requested X" or "who asked for X", call trace_request for X and give the requester line it returns. If it says none matches, say how many requests it read and that the requester is unknown.
- A short reply that is only a title ("The body") answers your earlier question. Call trace_request with it and never ask which title again. Do not ask for a file name.
- Never tell the user to call a tool or use a tool name as advice. Tool names are yours. Give the answer, or say what you could not read.
- seerr is a cache: never say episodes are "being processed by seerr" unless a tool said so. Say what Sonarr holds and whether anything is queued.
- For progress or ETA of a named title, call trace_request first, then list_queue. For download progress, speed, ETA, "how long until it is downloaded", "is it done yet" or "what is downloading", call list_queue. It lists torrents added by hand too and ends with the latest finished downloads. A follow-up like "how long until it's downloaded" refers to the title from the earlier turns: call list_queue and give that title's progress and ETA. Never say you cannot check download times.
- For "latest downloads" or "what downloaded recently", call list_queue and give the latest finished downloads section. Always show it with an ETA answer.
- No tool lists titles added to the Plex library or recent imports. For that question, say you have no such tool and offer the library tool for a whole-library summary or a title check. The finished downloads list is downloads, not library additions: label it that way.
- Sonarr and Radarr are ground truth. seerr is a cache and can disagree.
- When a tool returns an error or an ok=false finding, say which read failed and why. Never treat a failed read as "nothing found".
- You cannot change anything yourself. To search for subtitles or to check or install updates, call propose_action. For subtitles and update_apply it only asks the user to confirm. Never say a change happened; say it is proposed and a Confirm button follows. For subtitles, call bazarr_find first when the title is unclear. To find what lacks subtitles, call bazarr_find with missingOnly true and no title; never pass a word like "subtitles" as the title. When the user asks you to update or install something, propose update_apply for that target (an earlier stale_versions answer names it); use update_check only when they ask what is available. A check needs no confirmation, so never say Confirm for it. Refreshing Plex is not available in this chat yet.
- State only what a tool returned. If no tool said it, do not say it; say you did not check.
- A follow-up question gets the shortest direct answer: one line holding only the fact asked, such as "About 42 min." Do not restate the title, earlier facts or a fix line unless something is wrong. A multi-episode pack is one download.
- Name the tools you read, except in a one-line follow-up answer. Answer in at most 8 short lines, for a phone screen. No preamble.`;

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskOptions {
  /** Defaults to the lab prompt. */
  system?: string;
  /** Earlier turns of the same chat, oldest first. */
  history?: HistoryTurn[];
}

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
  /** The error text of each failed tool call, so the journal says why a read failed. */
  toolErrors?: Array<{ name: string; error: string }>;
  /** Changes the model proposed. None has run: pete-bot shows a Confirm button for each. */
  proposals: Proposal[];
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
  opts: AskOptions = {},
): Promise<AskResult> {
  const definitions = toolDefinitions(tools);
  // Cache the stable prefix: the system prompt and the tool list. Below the model's minimum
  // cacheable length this costs nothing and caches nothing; the ledger row shows which.
  const toolsParam = definitions.map((d, i) =>
    i === definitions.length - 1 ? { ...d, cache_control: { type: 'ephemeral' } } : d,
  );
  const system = [{ type: 'text', text: opts.system ?? SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    ...(opts.history ?? []),
    { role: 'user', content: question },
  ];
  const toolCalls: AskResult['toolCalls'] = [];
  const toolErrors: NonNullable<AskResult['toolErrors']> = [];
  const usage = { input: 0, output: 0, cacheRead: 0 };
  const proposals: Proposal[] = [];

  const stopped = (turns: number, why: string): AskResult => ({
    answer: `${why} Tools called: ${toolCalls.map((t) => `${t.name}${t.ok ? '' : ' (failed)'}`).join(', ') || 'none'}.`,
    turns,
    toolCalls,
    toolErrors,
    proposals,
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
      if (RAW_TOOL_CALL.test(text)) {
        // The model wrote a tool call as text instead of calling it. That is not an answer.
        return stopped(turn, 'I could not finish: the model ended on an unfinished tool call, so I have no answer to give you.');
      }
      const incomplete = Boolean(note) || !text;
      return { answer: (text || '(The model returned no text.)') + note, turns: turn, toolCalls, toolErrors, proposals, incomplete, usage };
    }
    if (last) {
      // tool_choice none should prevent this; if the model still asks, it gets no more reads.
      return stopped(turn, `I stopped after ${MAX_TURNS} model turns without a final answer.${text && !RAW_TOOL_CALL.test(text) ? ` Last note: ${text}` : ''}`);
    }

    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const use of uses) {
      const tool = tools.get(use.name ?? '');
      const result = tool
        ? await callTool(tool, use.input)
        : ({ ok: false, error: `no tool named ${use.name}` } as const);
      toolCalls.push({ name: use.name ?? '?', ok: result.ok });
      if (!result.ok) toolErrors.push({ name: use.name ?? '?', error: result.error.slice(0, MAX_ERROR_CHARS) });
      if (result.ok && use.name === PROPOSE_TOOL) {
        // The proposal is read from the tool's own JSON output, not from anything the model wrote.
        try {
          const p = (JSON.parse(result.text) as { data?: { proposal?: Proposal } }).data?.proposal;
          if (p) proposals.push(p);
        } catch {
          // A truncated or malformed result carries no proposal; the model's text still says what happened.
        }
      }
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
