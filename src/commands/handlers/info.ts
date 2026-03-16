// /info command handler
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { OllamaClient } from '../../ai/OllamaClient.js';
import { registry } from '../../ai/ToolRegistry.js';
import { logger } from '../../utils/index.js';

export async function handleInfoCommand(
  interaction: ChatInputCommandInteraction,
  ollamaClient: OllamaClient,
  allowedUsers: string[]
): Promise<void> {
  // Defer reply
  try {
    await interaction.deferReply();
  } catch (deferErr) {
    logger.warn(
      'deferReply failed:',
      deferErr instanceof Error ? deferErr.message : deferErr
    );
    return;
  }

  try {
    const ollamaAvailable = await ollamaClient.isAvailable();
    const toolCount = registry.size();

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Bot Information')
      .addFields(
        { name: 'Status', value: 'Online', inline: true },
        { name: 'AI Model', value: ollamaClient.getModel(), inline: true },
        { name: 'AI Service', value: ollamaAvailable ? 'Available' : 'Unavailable', inline: true },
        { name: 'Authorized Users', value: `${allowedUsers.length}`, inline: true },
        { name: 'Available Tools', value: `${toolCount}`, inline: true },
        {
          name: 'Commands',
          value: '`/ask` - Ask the AI a question\n`/tools` - List available tools\n`/help` - Get help and examples\n`/info` - Show bot info',
          inline: false,
        }
      )
      .setTimestamp();

    try {
      await interaction.editReply({ embeds: [embed] });
    } catch (replyErr) {
      logger.warn(
        'Failed to send info embed reply:',
        replyErr instanceof Error ? replyErr.message : replyErr
      );
      try {
        await interaction.followUp({
          content: 'Failed to send info in channel.',
          ephemeral: true,
        });
      } catch (fuErr) {
        logger.error('followUp failed:', fuErr);
      }
    }
  } catch (error) {
    logger.error('Info command error:', error);
    try {
      await interaction.editReply({ content: 'Failed to retrieve bot information.' });
    } catch (errReply) {
      logger.error('Failed to send error reply:', errReply);
    }
  }
}

export default handleInfoCommand;
