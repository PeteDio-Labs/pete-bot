// /help command — explains what Pete Bot does and points to MC Web
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { logger } from '../../utils/index.js';

export async function handleHelpCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('Pete Bot')
    .setDescription(
      'I relay infrastructure alerts and agent results to Discord.\n\n' +
        '**What I do:**\n' +
        '- DM you when a **critical** or **warning** infrastructure event fires\n' +
        '- DM you when an **agent** (ops-investigator, blog-agent, etc.) completes a task\n' +
        '- Forward events from the MC Backend SSE stream\n\n' +
        '**What I do NOT do:**\n' +
        '- Answer questions about infrastructure — use Mission Control Web\n' +
        '- Run investigations — ops-investigator handles those automatically\n' +
        '- Execute commands — approvals happen in MC Web\n\n' +
        '**Mission Control:** Use MC Web to view alerts, agent runs, and approve actions.',
    )
    .setFooter({ text: 'Pete Bot — notification relay only' })
    .setTimestamp();

  try {
    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (err) {
    logger.error('Failed to send help reply:', err instanceof Error ? err.message : err);
  }
}

export default handleHelpCommand;
