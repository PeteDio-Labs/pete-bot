/**
 * The merge desk's Discord side (PET-645): DMs to the owner, and the buttons on them.
 *
 * ⚠ A BUTTON IS A REQUEST, NOT A MERGE. The tap names one PR and one SHA. The desk reads
 * every fact again and merges only that SHA, only when every gate still passes, and only
 * for the owner. Anyone else who sees a button gets a refusal.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type DMChannel } from 'discord.js';
import type { Button, Notifier } from './desk.js';

const STYLES: Record<Button['style'], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  danger: ButtonStyle.Danger,
};

export function discordNotifier(client: Client, ownerUserId: string): Notifier {
  return {
    async dm(content, buttons = []) {
      const user = await client.users.fetch(ownerUserId);
      const dm = (await user.createDM()) as DMChannel;
      const components = buttons.length
        ? [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              buttons.map((b) => new ButtonBuilder().setCustomId(b.customId).setLabel(b.label).setStyle(STYLES[b.style])),
            ),
          ]
        : [];
      // PR titles and paths are other people's text, so nothing in a DM may ping anyone.
      await dm.send({ content: content.slice(0, 1990), components, allowedMentions: { parse: [] } });
    },
  };
}
