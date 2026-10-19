// /lab — ask the lab-map agent a question about the homelab (PET-669).
//
// "Where does Plane run", "is Vault up", "what changed on 237". pete-bot passes the
// question to lab-agent on 127.0.0.1, which answers from read-only tools and names its
// sources. pete-bot itself runs no model and reads nothing in the lab.
import { SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType } from 'discord.js';

export const labCommand = new SlashCommandBuilder()
  .setName('lab')
  .setDescription('Ask where something runs, whether it is up, or what changed')
  .addStringOption((option) =>
    option.setName('question').setDescription('Such as: where does plane run').setRequired(true).setMinLength(3).setMaxLength(500),
  )
  .setIntegrationTypes([ApplicationIntegrationType.UserInstall])
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ])
  .toJSON();

export default labCommand;
