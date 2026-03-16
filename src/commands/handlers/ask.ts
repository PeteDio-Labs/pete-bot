// /ask command handler with tool support
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { OllamaClient } from '../../ai/OllamaClient.js';
import { ToolExecutor } from '../../ai/ToolExecutor.js';
import { isUserAuthorized, logger } from '../../utils/index.js';

function truncate(text: string | undefined, maxLength: number): string {
  if (!text) return 'No response';
  return text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text;
}

async function sendFullResponseDM(
  interaction: ChatInputCommandInteraction,
  fullText: string
): Promise<void> {
  const chunkSize = 1900;
  try {
    const dmChannel = await interaction.user.createDM();
    for (let i = 0; i < fullText.length; i += chunkSize) {
      const chunk = fullText.substring(i, i + chunkSize);
      await dmChannel.send({ content: chunk });
    }
    await interaction.followUp({ content: 'Full answer sent to your DMs.', ephemeral: true });
  } catch (dmErr) {
    logger.warn(
      'Could not DM user; falling back to ephemeral follow-ups:',
      dmErr instanceof Error ? dmErr.message : dmErr
    );
    try {
      for (let i = 0; i < fullText.length; i += chunkSize) {
        const chunk = fullText.substring(i, i + chunkSize);
        await interaction.followUp({ content: chunk, ephemeral: true });
      }
    } catch (followErr) {
      logger.error('Failed to send full answer in follow-ups:', followErr);
    }
  }
}

export async function handleAskCommand(
  interaction: ChatInputCommandInteraction,
  ollamaClient: OllamaClient,
  allowedUsers: string[]
): Promise<void> {
  logger.info(`/ask command received from user ${interaction.user.tag} (${interaction.user.id})`);

  // Check authorization first
  if (!isUserAuthorized(interaction.user.id, allowedUsers)) {
    logger.info(`User ${interaction.user.id} is not authorized`);
    try {
      await interaction.reply({
        content: 'You are not authorized to use this command.',
        ephemeral: true,
      });
    } catch (err) {
      logger.warn('Auth reply failed:', err instanceof Error ? err.message : err);
    }
    return;
  }

  // Defer reply IMMEDIATELY - must happen within 3 seconds
  try {
    await interaction.deferReply();
  } catch (deferErr) {
    logger.error(
      'deferReply failed - interaction likely expired:',
      deferErr instanceof Error ? deferErr.message : deferErr
    );
    return;
  }

  try {
    const question = interaction.options.getString('question', true);
    logger.info(`Processing question: "${question.substring(0, 100)}${question.length > 100 ? '...' : ''}"`);

    // Check if Ollama is available
    const isAvailable = await ollamaClient.isAvailable();
    if (!isAvailable) {
      logger.warn('Ollama service unavailable');
      await interaction.editReply({
        content: 'AI service is currently unavailable. Please try again later.',
      });
      return;
    }
    logger.info('Ollama service is available');

    const executor = new ToolExecutor(ollamaClient);

    // Process message with tool support
    const result = await executor.processMessage(question);
    logger.info(`Tool execution completed. Tools used: ${result.toolsUsed.map((t) => t.name).join(', ') || 'none'}`);
    logger.debug(`Response length: ${result.response.length} characters`);

    // Build response embed
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('AI Response')
      .addFields(
        { name: 'Question', value: truncate(question, 1024), inline: false },
        { name: 'Answer', value: truncate(result.response, 1024), inline: false }
      )
      .setTimestamp()
      .setFooter({ text: `Requested by ${interaction.user.tag}` });

    // Add tools used if any (compress repeated names: "tool ×N")
    if (result.toolsUsed.length > 0) {
      const toolCounts = new Map<string, number>();
      for (const t of result.toolsUsed) {
        toolCounts.set(t.name, (toolCounts.get(t.name) || 0) + 1);
      }
      const toolSummary = Array.from(toolCounts.entries())
        .map(([name, count]) => count > 1 ? `\`${name}\` ×${count}` : `\`${name}\``)
        .join(', ');
      embed.addFields({ name: 'Tools Used', value: toolSummary, inline: false });
    }

    try {
      await interaction.editReply({ embeds: [embed] });
      logger.info(`/ask command completed successfully for user ${interaction.user.id}`);
    } catch (replyErr) {
      logger.error(
        'Failed to send embed reply:',
        replyErr instanceof Error ? replyErr.message : replyErr
      );
    }

    // Handle truncated responses (DM full answer)
    if (result.response.length > 1024) {
      await sendFullResponseDM(interaction, result.response);
    }
  } catch (error) {
    logger.error('Ask command error:', error);
    try {
      await interaction.editReply({
        content: 'Failed to get AI response. Please try again later.',
      });
    } catch (errReply) {
      logger.error('Failed to send error reply:', errReply instanceof Error ? errReply.message : errReply);
    }
  }
}

export default handleAskCommand;
