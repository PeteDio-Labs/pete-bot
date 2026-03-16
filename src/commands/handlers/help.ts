// /help command handler - user-facing guidance and example prompts
import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { toolCatalog } from '../../data/toolCatalog.js';
import { logger } from '../../utils/index.js';

export async function handleHelpCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const topic = interaction.options.getString('topic');

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTimestamp();

  if (!topic) {
    // General help
    embed.setTitle('Bot Help');
    embed.setDescription(
      'I can answer questions about your homelab infrastructure using AI and tools.\n\n' +
      '**Commands:**\n' +
      '`/ask` — Ask the AI a question (uses tools automatically)\n' +
      '`/tools` — List available tools and their actions\n' +
      '`/help` — This help page\n' +
      '`/info` — Bot status and system info\n\n' +
      '**Tips:**\n' +
      '- Ask naturally: "show me all argocd apps" or "what is downloading"\n' +
      '- Use `/help topic:<tool>` for example prompts per tool\n' +
      '- Use `/tools tool:<tool>` for action and parameter details'
    );
  } else if (topic === 'tools') {
    // Tools overview with examples
    embed.setTitle('Tool Help');
    embed.setDescription('Here are the tools I can use and what you can ask:');

    for (const [name, entry] of Object.entries(toolCatalog)) {
      const exampleList = entry.examples.slice(0, 3).map((e) => `- ${e}`).join('\n');
      embed.addFields({
        name: name,
        value: `${entry.summary}\n${exampleList}`,
        inline: false,
      });
    }
  } else {
    // Per-tool help
    const entry = toolCatalog[topic];
    if (!entry) {
      embed.setTitle('Unknown Topic').setDescription(`No help available for \`${topic}\`.`);
    } else {
      embed.setTitle(`Help: ${topic}`);

      if (entry.type === 'action-based' && entry.actions) {
        const capabilities = entry.actions
          .map((a) => `- ${a.description}`)
          .join('\n');
        embed.setDescription(`You can ask about:\n${capabilities}`);
      } else {
        embed.setDescription(entry.summary);
      }

      embed.addFields({
        name: 'Try asking:',
        value: entry.examples.map((e) => `- ${e}`).join('\n'),
        inline: false,
      });

      if (entry.notes) {
        embed.addFields({
          name: 'Notes',
          value: entry.notes,
          inline: false,
        });
      }
    }
  }

  try {
    await interaction.reply({ embeds: [embed] });
  } catch (replyErr) {
    logger.warn(
      'Failed to send help embed reply:',
      replyErr instanceof Error ? replyErr.message : replyErr
    );
    try {
      await interaction.followUp({ content: 'Failed to send help.', ephemeral: true });
    } catch (fuErr) {
      logger.error('followUp failed:', fuErr);
    }
  }
}

export default handleHelpCommand;
