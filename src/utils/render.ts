/**
 * Rendering an mtrace answer into Discord embeds.
 *
 * ⚠ PAGE, DO NOT TRUNCATE. Both surfaces used to do `text.slice(0, 3997) + '...'`.
 * mtrace's long answers are its deep ones — a trace crossing six hosts over SSH — and a
 * trace states its conclusion last. Cutting the tail keeps the preamble and throws away
 * the answer, which is the opposite of the trade a length limit should make.
 */
import { EmbedBuilder } from 'discord.js';

/** Discord's own cap is 4096. The headroom absorbs the truncation notice below. */
export const EMBED_DESCRIPTION_LIMIT = 4000;

/** Discord accepts 10 embeds per message. Eight pages is 32,000 characters. */
export const MAX_EMBEDS = 8;

export const COLOR_OK = 0x57f287;

const EMPTY = '_mtrace returned an empty answer._';
const CUT = '\n\n_… answer truncated; ask mtrace directly for the rest._';

/**
 * Split on a newline when one falls in the back half of the page, so a page break lands
 * between lines rather than mid-word. The newline leads the next page instead of being
 * dropped: pages concatenate back to the original text exactly, and a test can assert
 * that rather than eyeballing it.
 */
function paginate(text: string): string[] {
  const pages: string[] = [];
  let rest = text;

  while (rest.length > EMBED_DESCRIPTION_LIMIT) {
    const newline = rest.lastIndexOf('\n', EMBED_DESCRIPTION_LIMIT);
    const cut = newline > EMBED_DESCRIPTION_LIMIT / 2 ? newline : EMBED_DESCRIPTION_LIMIT;
    pages.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pages.push(rest);
  return pages;
}

export function answerEmbeds(text: string, footerText?: string, color = COLOR_OK): EmbedBuilder[] {
  let pages = paginate(text);
  if (pages.length === 1 && !pages[0]) pages = [EMPTY];

  if (pages.length > MAX_EMBEDS) {
    pages = pages.slice(0, MAX_EMBEDS);
    const last = pages[MAX_EMBEDS - 1]!;
    pages[MAX_EMBEDS - 1] = last.slice(0, EMBED_DESCRIPTION_LIMIT - CUT.length) + CUT;
  }

  return pages.map((page, i) => {
    const embed = new EmbedBuilder().setColor(color).setDescription(page);
    // Footer the last page only. Repeating the timing on every page reads as though the
    // answer took that long each time.
    if (footerText && i === pages.length - 1) embed.setFooter({ text: footerText });
    return embed;
  });
}
