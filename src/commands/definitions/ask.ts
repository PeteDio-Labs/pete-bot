// /ask — put a question to mtrace and get its answer back in this DM.
//
// ⚠ USER-INSTALLED, NOT GUILD-INSTALLED. setIntegrationTypes([1]) is what makes this
// an app Pedro installs to his own account rather than a bot living in a server, and
// PRIVATE_CHANNEL (context 2) is only available to commands that declare it. Discord's
// user context grants `applications.commands` and nothing more, which is all this needs.
//
// Contexts: 0 GUILD, 1 BOT_DM, 2 PRIVATE_CHANNEL. All three are declared so the command
// works wherever he happens to be, but the DM with the app is the intended home.
import { SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType } from 'discord.js';

export const askCommand = new SlashCommandBuilder()
  .setName('ask')
  .setDescription('Ask mtrace about the media stack')
  .addStringOption((option) =>
    option
      .setName('question')
      .setDescription('e.g. why is rick and morty not showing up in plex?')
      .setRequired(true),
  )
  .setIntegrationTypes([ApplicationIntegrationType.UserInstall])
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ])
  .toJSON();

export default askCommand;
