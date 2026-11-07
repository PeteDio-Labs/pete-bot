/**
 * Shows the media assistant's proposals in the DM (PET-869): a Confirm button for a change,
 * and an immediate run for an update check, which changes nothing.
 */
import type { Message } from 'discord.js';
import { config } from '../config.js';
import { runUpdate } from '../clients/githubActions.js';
import type { Proposal } from '../lab/tools/propose.js';
import { outcomeEmbed } from '../events/interactionCreate.js';
import { logger } from '../utils/index.js';
import { mediaPending, proposalRow, type PendingStore } from './actions.js';

export function createPresenter(store: PendingStore = mediaPending, run: typeof runUpdate = runUpdate) {
  return async function present(message: Message, proposals: Proposal[]): Promise<void> {
    for (const p of proposals) {
      if (p.confirm) {
        const id = store.add(p);
        await message.reply({ content: `**${p.label}**\nTap Confirm to run it. It expires in 10 minutes.`, components: [proposalRow(id)] });
        continue;
      }
      // An update check reads the stack and changes nothing, so it runs without a tap.
      if (!config.updates.token) {
        await message.reply('`GITHUB_UPDATES_TOKEN` is empty on this host, so I cannot start an update check.');
        continue;
      }
      await message.reply(`${p.label}: starting the check. It takes a few minutes.`);
      try {
        const outcome = await run('check', p.target, false, {});
        await message.reply({ embeds: [outcomeEmbed('check', p.target, outcome)] });
      } catch (err) {
        logger.error(`media update check failed: ${err instanceof Error ? err.message : String(err)}`);
        await message.reply(`❌ The update check did not run: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
      }
    }
  };
}
