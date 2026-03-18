// /tools command definition
import { SlashCommandBuilder } from 'discord.js';

export const toolsCommand = new SlashCommandBuilder()
  .setName('tools')
  .setDescription('List available AI tools')
  .addStringOption((option) =>
    option
      .setName('tool')
      .setDescription('Show detailed info for a specific tool')
      .setRequired(false)
      .addChoices(
        { name: 'mission_control', value: 'mission_control' },
        { name: 'web_search', value: 'web_search' },
        { name: 'calculate', value: 'calculate' },
        { name: 'get_current_time', value: 'get_current_time' },
      )
  )
  .toJSON();

export default toolsCommand;
