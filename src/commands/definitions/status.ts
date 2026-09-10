// /status — is the thing that answers questions actually up?
//
// Without this the only way to find out is to ask a question and read the error embed,
// which cannot tell "mtrace is down" apart from "mtrace could not answer that".
import { SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType } from 'discord.js';

export const statusCommand = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Is mtrace reachable, and what is pete-bot holding?')
  .setIntegrationTypes([ApplicationIntegrationType.UserInstall])
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ])
  .toJSON();

export default statusCommand;
