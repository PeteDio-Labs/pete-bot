// /status — what is pete-bot holding right now?
//
// Open incidents, uptime, and whether /update has a token. It asks mtrace nothing: pete-bot
// stopped calling mtrace in PET-518, and mtrace left loopback in the same change.
import { SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType } from 'discord.js';

export const statusCommand = new SlashCommandBuilder()
  .setName('status')
  .setDescription('What is pete-bot holding: open incidents, uptime, /update')
  .setIntegrationTypes([ApplicationIntegrationType.UserInstall])
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ])
  .toJSON();

export default statusCommand;
