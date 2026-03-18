// /help command definition
import { SlashCommandBuilder } from 'discord.js';

export const helpCommand = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Get help and example prompts')
  .addStringOption((option) =>
    option
      .setName('topic')
      .setDescription('Help topic (e.g., a tool name like mission_control)')
      .setRequired(false)
      .addChoices(
        { name: 'tools', value: 'tools' },
        { name: 'mission_control', value: 'mission_control' },
        { name: 'web_search', value: 'web_search' },
        { name: 'calculate', value: 'calculate' },
        { name: 'get_current_time', value: 'get_current_time' },
      )
  )
  .toJSON();

export default helpCommand;
