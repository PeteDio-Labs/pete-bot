/**
 * The media assistant's front door (PET-869): a plain DM from the owner is a question.
 *
 * ⚠ OWNER ONLY, DM ONLY. A message from anyone else, from a bot (including this one), or
 * from a server channel is ignored without an answer, so the app never reveals itself to
 * a stranger. The gate is the author's id, not a header or a name.
 *
 * ⚠ A FAILURE IS SAID, NEVER SKIPPED. A model that is cold, lab-agent being down and an
 * empty answer all produce a visible line saying so. Silence reads as "it worked".
 */
import type { Message } from 'discord.js';
import { askMedia, type MediaOutcome, type MediaTurn } from '../clients/mediaAgent.js';
import type { Proposal } from '../lab/tools/propose.js';
import { logger } from '../utils/index.js';

/** Discord's message limit is 2000 characters. */
const CHUNK = 1900;
/** Turns kept per owner, so "and the next episode?" works. Memory only, lost on restart. */
export const HISTORY_TURNS = 6;

export interface DmHandlerDeps {
  ownerUserId: string;
  ask?: (question: string, history: MediaTurn[]) => Promise<MediaOutcome>;
  /** Shows the changes the model proposed (buttons, or a check that runs now). Absent, they are said but not offered. */
  present?: (message: Message, proposals: Proposal[]) => Promise<void>;
  /** Tests pass a clock so the history expiry is deterministic. */
  now?: () => number;
  /** A conversation idle this long starts fresh. */
  idleMs?: number;
}

/** Splits at line breaks where it can, so a table is not cut in the middle of a row. */
export function chunk(text: string, size = CHUNK): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export function describe(outcome: MediaOutcome): string {
  if (outcome.kind === 'not-configured') return 'The media assistant is not configured on this host (`LAB_ASK_TOKEN` is empty).';
  if (outcome.kind === 'failed') return `No answer: ${outcome.reason.slice(0, 500)}`;
  const r = outcome.result;
  const failed = r.toolCalls.filter((t) => !t.ok).length;
  const tools = [...new Set(r.toolCalls.map((t) => t.name))].join(', ') || 'none';
  // Name why a read failed, in the footer, so a failure can be read without the journal.
  const why = (r.toolErrors ?? []).slice(0, 2).map((e) => `${e.name}: ${e.error.replace(/\s+/g, ' ').slice(0, 120)}`).join('; ');
  const notes = [r.incomplete ? 'incomplete' : '', failed ? `${failed} read(s) failed${why ? ` (${why})` : ''}` : ''].filter(Boolean).join(', ');
  const footer = `-# read: ${tools}${notes ? ` · ${notes}` : ''}`;
  return `${r.answer.trim() || '(empty answer)'}\n${footer}`;
}

export function createDmHandler(deps: DmHandlerDeps, cfg: Parameters<typeof askMedia>[2]) {
  const ask = deps.ask ?? ((q: string, h: MediaTurn[]) => askMedia(q, h, cfg));
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? 30 * 60_000;
  let history: MediaTurn[] = [];
  let lastAt = 0;
  let busy = false;

  return async function onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (message.guildId) return;
    if (message.author.id !== deps.ownerUserId) return;
    const text = (message.content ?? '').trim();
    if (!text) return;

    if (busy) {
      await message.reply('Still working on your last question. Send this again when I answer.');
      return;
    }
    busy = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      if (now() - lastAt > idleMs) history = [];
      // Discord clears the typing indicator after 10 s and a cold model load takes 22 s
      // (MED-3), so it is sent again every 8 s until the answer is ready.
      const channel = message.channel;
      const typing = () => ('sendTyping' in channel ? channel.sendTyping().catch(() => undefined) : undefined);
      await typing();
      timer = setInterval(() => void typing(), 8000);
      logger.info(`[media] question (${text.length} chars, ${history.length} turns of history)`);
      const outcome = await ask(text, history);
      if (outcome.kind === 'failed') logger.error(`[media] failed: ${outcome.reason}`);
      for (const part of chunk(describe(outcome))) await message.reply(part);
      if (outcome.kind === 'answer' && outcome.result.proposals.length > 0) {
        if (!deps.present) await message.reply('(Changes were proposed, but this host cannot offer a Confirm button, so nothing ran.)');
        else {
          try {
            await deps.present(message, outcome.result.proposals);
          } catch (err) {
            logger.error('[media] could not present proposals:', err);
            await message.reply('I could not show the Confirm button, so nothing ran. Ask again.');
          }
        }
      }
      if (outcome.kind === 'answer') {
        history = [...history, { role: 'user' as const, content: text }, { role: 'assistant' as const, content: outcome.result.answer }].slice(-HISTORY_TURNS);
        lastAt = now();
      }
    } finally {
      if (timer) clearInterval(timer);
      busy = false;
    }
  };
}
