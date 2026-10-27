// /report — send one of the scheduled reports now (PET-701).
//
// It runs the same code as the schedule and DMs the owner, so a report can be proven beside
// the Claude routine it replaces without waiting for 07:52.
import { SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType } from 'discord.js';

export const reportCommand = new SlashCommandBuilder()
  .setName('report')
  .setDescription('Send a scheduled report now')
  .addStringOption((option) =>
    option
      .setName('which')
      .setDescription('Which report')
      .setRequired(true)
      .addChoices(
        { name: 'morning queue', value: 'morning' },
        { name: 'hanging audit', value: 'audit' },
        { name: 'stale PR sweep', value: 'sweep' },
        { name: 'CVE check', value: 'cve' },
      ),
  )
  .setIntegrationTypes([ApplicationIntegrationType.UserInstall])
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ])
  .toJSON();

export default reportCommand;
