// /code command definition
import { SlashCommandBuilder } from 'discord.js';

export const codeCommand = new SlashCommandBuilder()
  .setName('code')
  .setDescription('Ask the coding agent to plan and execute a code task with human approval')
  .addStringOption((option) =>
    option.setName('task').setDescription('Describe what you want the coding agent to do').setRequired(true)
  )
  .toJSON();

export default codeCommand;
