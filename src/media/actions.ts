/**
 * Pending changes for the media assistant (PET-869): the Confirm and Cancel buttons.
 *
 * ⚠ A TAP IS THE ONLY WAY A CHANGE RUNS. The model proposes, this store holds the proposal,
 * and a button press by the owner takes it out and runs it once. A button the owner never
 * pressed, a second press, a press after the ten-minute expiry and a press by anyone else
 * each run nothing, and each says so.
 *
 * ⚠ THE BUTTON NAMES AN ID, NOT AN ACTION. The customId holds a random id; the action and
 * its arguments stay in this process's memory, so a forged customId cannot name a different
 * title or target. A restart empties the store, and old buttons then say they expired.
 */
import { randomBytes } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { actMedia, type MediaClientConfig } from '../clients/mediaAgent.js';
import { runUpdate } from '../clients/githubActions.js';
import type { UpdateOutcome } from '../clients/githubActions.js';
import type { Proposal } from '../lab/tools/propose.js';

export const MEDIA_BUTTON_PREFIX = 'media';
export const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;

export class PendingStore {
  private items = new Map<string, { proposal: Proposal; at: number }>();
  constructor(
    private ttlMs = PENDING_TTL_MS,
    private now: () => number = Date.now,
  ) {}

  add(proposal: Proposal): string {
    this.sweep();
    // The oldest goes first when the owner never taps, so the store cannot grow without bound.
    while (this.items.size >= MAX_PENDING) this.items.delete(this.items.keys().next().value as string);
    const id = randomBytes(8).toString('hex');
    this.items.set(id, { proposal, at: this.now() });
    return id;
  }

  /** Removes and returns the proposal. A second take of the same id returns nothing. */
  take(id: string): Proposal | undefined {
    const hit = this.items.get(id);
    this.items.delete(id);
    if (!hit || this.now() - hit.at > this.ttlMs) return undefined;
    return hit.proposal;
  }

  get size(): number {
    return this.items.size;
  }

  private sweep(): void {
    for (const [id, v] of this.items) if (this.now() - v.at > this.ttlMs) this.items.delete(id);
  }
}

export const mediaPending = new PendingStore();

export function proposalRow(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${MEDIA_BUTTON_PREFIX}:ok:${id}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${MEDIA_BUTTON_PREFIX}:no:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
}

export function parseButton(customId: string): { verb: 'ok' | 'no'; id: string } | null {
  const m = /^media:(ok|no):([0-9a-f]{16})$/.exec(customId);
  return m ? { verb: m[1] as 'ok' | 'no', id: m[2]! } : null;
}

export type ProposalResult =
  | { kind: 'text'; ok: boolean; text: string }
  | { kind: 'update'; mode: 'check' | 'apply'; target: string; outcome: UpdateOutcome };

export interface RunDeps {
  act?: typeof actMedia;
  update?: typeof runUpdate;
  media: MediaClientConfig;
  onStarted?: (url: string) => Promise<void>;
}

/** Runs one proposal. A failure comes back as a result that says it failed, never as silence. */
export async function runProposal(p: Proposal, deps: RunDeps): Promise<ProposalResult> {
  if (p.action === 'subtitles') {
    const out = await (deps.act ?? actMedia)(p.kind, p.id, deps.media);
    if (out.kind === 'done') return { kind: 'text', ok: true, text: `${p.title}: ${out.message}` };
    if (out.kind === 'not-configured') return { kind: 'text', ok: false, text: 'The media assistant is not configured on this host (`LAB_ASK_TOKEN` is empty). Nothing ran.' };
    return { kind: 'text', ok: false, text: `The subtitle search did not run: ${out.reason.slice(0, 300)}` };
  }
  const mode = p.action === 'update_check' ? 'check' : 'apply';
  const outcome = await (deps.update ?? runUpdate)(mode, p.target, false, {
    onStarted: async (run) => {
      await deps.onStarted?.(run.url);
    },
  });
  return { kind: 'update', mode, target: p.target, outcome };
}
