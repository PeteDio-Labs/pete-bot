/**
 * propose_action (PET-869): how the model asks for a change.
 *
 * ⚠ THIS TOOL CHANGES NOTHING. It validates a request and returns a proposal. The server
 * hands the proposal to pete-bot, which shows a Confirm button, and a tap by the owner runs
 * it. A model that is steered by a title, a torrent name or a tracker message can propose,
 * and it still cannot act.
 *
 * ⚠ FIVE ACTIONS EXIST, each fully specified: a subtitle search and a download search, each for ONE
 * title that resolved to ONE library item, an update check, an update apply for one named target, and
 * `choose`, a clarification card that changes nothing. A title that matches several items does not
 * throw and is not guessed: it becomes a `choose` card of the candidates, and the tap re-asks.
 */
import { z } from 'zod';
import { listItems, matchTitle, type Item, type BazarrConfig, type BazarrKind } from './bazarr.js';
import { LabToolError, type LabTool } from './types.js';

/** Mirrors UPDATE_TARGETS in src/clients/githubActions.ts. A test keeps the two equal. */
export const PROPOSE_TARGETS = ['plex', 'sonarr', 'radarr', 'prowlarr', 'bazarr', 'arr', 'plex-and-arr'] as const;
export const PROPOSE_TOOL = 'propose_action';

export type Proposal =
  | { action: 'subtitles'; kind: BazarrKind; id: number; title: string; label: string; confirm: true }
  | { action: 'download'; kind: BazarrKind; title: string; season?: number; label: string; confirm: true }
  | { action: 'choose'; label: string; options: Array<{ label: string; reply: string }>; confirm: false }
  | { action: 'update_check'; target: (typeof PROPOSE_TARGETS)[number]; label: string; confirm: false }
  | { action: 'update_apply'; target: (typeof PROPOSE_TARGETS)[number]; label: string; confirm: true };

/**
 * One library item for a title, or a card. An exact or partial match resolves. A match that needed a
 * typo fix never runs: it becomes a "Did you mean" card, so a tired tap cannot search the wrong show.
 */
function resolve(items: Item[], title: string, kind: BazarrKind | undefined, reply: (m: Item) => string): { item: Item } | { card: Proposal } | { none: true } {
  const pool = kind ? items.filter((i) => i.kind === kind) : items;
  const dup = (m: Item) => pool.filter((x) => x.title === m.title).length > 1;
  const name = (m: Item) => `${m.title}${dup(m) ? ` (${m.kind})` : ''}`.slice(0, 40);
  const card = (label: string, ms: Item[]): Proposal => ({ action: 'choose', label, options: ms.slice(0, 4).map((m) => ({ label: name(m), reply: reply(m) })), confirm: false });
  const sure = matchTitle(pool, title, { typo: false });
  if (sure.length === 1) return { item: sure[0]! };
  if (sure.length > 1) return { card: card(`Which "${title.slice(0, 60)}" do you mean?`, sure) };
  const near = matchTitle(pool, title);
  if (near.length) return { card: card(`I found no "${title.slice(0, 60)}". Did you mean one of these?`, near) };
  return { none: true };
}

export function proposeActionTool(bazarr: BazarrConfig | undefined): LabTool {
  const input = z.object({
    action: z.enum(['subtitles', 'download', 'choose', 'update_check', 'update_apply']),
    kind: z.enum(['series', 'movie']).optional().describe('For download or subtitles: series or movie, to tell apart two items with one title'),
    season: z.number().int().min(0).max(100).optional().describe('For download of a show: the season number. Leave out for a movie or the whole show.'),
    question: z.string().min(3).max(200).optional().describe('For choose: the question to put on the card'),
    options: z
      .array(z.object({ label: z.string().min(1).max(40), reply: z.string().min(3).max(200).describe('A full sentence that answers the question on its own, sent back as the user\'s next message') }))
      .min(2)
      .max(4)
      .optional()
      .describe('For choose: two to four buttons'),
    title: z.string().min(2).max(200).optional().describe('For subtitles: the title to search subtitles for'),
    target: z.enum(PROPOSE_TARGETS).optional().describe('For update_check and update_apply: which services'),
  });
  return {
    name: PROPOSE_TOOL,
    description:
      'Propose an action. For subtitles, download and update_apply this only asks the user to confirm and does not run it. Use action "download" with a title (and season for a show) when the user asks to get, grab, download or find episodes or a movie. ' +
      'Use action "subtitles" only when the user says subtitles or captions. When you cannot tell which they mean, or a title is unclear, call "choose" with a question and two to four options so the user taps instead of you guessing. ' +
      'Use action "subtitles" with a title to search for missing subtitles, ' +
      '"update_check" with a target only to look (it needs no confirmation), or "update_apply" with a target to install. ' +
      'When the user says update, install or upgrade, call update_apply for the named service, not update_check. ' +
      'Tell the user what you proposed. For subtitles and update_apply, say a Confirm button will follow. For update_check, say the check is starting.',
    input,
    async run({ action, title, target, season, question, options, kind }: z.infer<typeof input>) {
      if (action === 'choose') {
        if (!question || !options) throw new LabToolError('propose_action: choose needs a question and two to four options');
        const proposal: Proposal = { action: 'choose', label: question, options, confirm: false };
        return { source: 'a clarification card', data: { proposal, pending: 'The user sees buttons and taps one. Nothing has run. Say only that you need them to pick.' } };
      }
      if (action === 'download' || action === 'subtitles') {
        if (!title) throw new LabToolError(`propose_action: ${action} needs a title`);
        if (!bazarr) throw new LabToolError('propose_action: the library list is not configured on this host, so a title cannot be resolved');
        const reply = (m: Item) =>
          action === 'subtitles'
            ? `Search subtitles for the ${m.kind} ${m.title}`
            : `Download ${m.kind === 'series' && season !== undefined ? `season ${season} of ` : ''}the ${m.kind} ${m.title}`;
        const r = resolve(await listItems(bazarr), title, kind, reply);
        if ('none' in r) throw new LabToolError(`propose_action: no show or movie in the library matches "${title.slice(0, 60)}". Ask the user with a choose card whether to try another spelling.`);
        if ('card' in r) return { source: `library: "${title.slice(0, 60)}" needs a choice`, data: { proposal: r.card, pending: 'A card was made for the user. Nothing has run.' } };
        const m = r.item;
        if (action === 'subtitles') {
          const proposal: Proposal = { action: 'subtitles', kind: m.kind, id: m.id, title: m.title, label: `Search subtitles for ${m.title} (${m.missing} missing)`, confirm: true };
          return { source: `Bazarr: one title matched "${title.slice(0, 60)}"`, data: { proposal, pending: 'The user must tap Confirm. Nothing has run.' } };
        }
        const sn = m.kind === 'series' ? season : undefined;
        const proposal: Proposal = {
          action: 'download',
          kind: m.kind,
          title: m.title,
          ...(sn !== undefined ? { season: sn } : {}),
          label: `Search for ${m.kind === 'series' ? (sn !== undefined ? `season ${sn} of ` : 'missing episodes of ') : ''}${m.title} (${m.kind === 'series' ? 'Sonarr' : 'Radarr'})`,
          confirm: true,
        };
        return { source: `library: one title matched "${title.slice(0, 60)}"`, data: { proposal, pending: 'The user must tap Confirm. Nothing has run.' } };
      }
      if (!target || (action !== 'update_check' && action !== 'update_apply')) throw new LabToolError(`propose_action: ${action} needs a target (${PROPOSE_TARGETS.join(', ')})`);
      const proposal: Proposal =
        action === 'update_check'
          ? { action, target, label: `Check updates for ${target}`, confirm: false }
          : { action, target, label: `Install updates for ${target}`, confirm: true };
      return {
        source: 'media-updates.yml targets',
        data: { proposal, pending: proposal.confirm ? 'The user must tap Confirm. Nothing has run.' : 'This is a read-only check with nothing to confirm. It runs as soon as you answer, and its report follows. Do not tell the user to confirm.' },
      };
    },
  };
}
