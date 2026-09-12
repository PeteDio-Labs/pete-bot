// /update — check for, or apply, media-stack updates (PET-395).
//
// Two subcommands, because an apply should never be one mistyped option away from a
// check. /update check reports what is available and changes nothing; /update apply
// runs it. Both start petedio-media-iac's media-updates.yml. This app holds no access to
// the hosts, only a token that can start that workflow.
//
// The target list mirrors the workflow's own choice input. Discord offers these, and the
// workflow refuses anything else.
import { SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import { UPDATE_TARGETS, type UpdateTarget } from '../../clients/githubActions.js';

const LABELS: Record<UpdateTarget, string> = {
  plex: 'Plex',
  sonarr: 'Sonarr',
  radarr: 'Radarr',
  prowlarr: 'Prowlarr',
  arr: 'Sonarr, Radarr and Prowlarr',
  'plex-and-arr': 'Plex and the *arr apps',
};
const choices = UPDATE_TARGETS.map((value) => ({ name: LABELS[value], value }));

export const updateCommand = new SlashCommandBuilder()
  .setName('update')
  .setDescription('Check for or apply media-stack updates')
  .addSubcommand((sub) =>
    sub
      .setName('check')
      .setDescription('Report current and available versions; changes nothing')
      .addStringOption((option) =>
        option
          .setName('target')
          .setDescription('Which services (default: Plex and the *arr apps)')
          .addChoices(...choices),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('apply')
      .setDescription('Apply available updates; Plex skips itself while anyone is watching')
      .addStringOption((option) =>
        option.setName('target').setDescription('Which services').setRequired(true).addChoices(...choices),
      )
      .addBooleanOption((option) =>
        option.setName('force').setDescription('Plex only: update even while someone is watching'),
      ),
  )
  .setIntegrationTypes([ApplicationIntegrationType.UserInstall])
  .setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ])
  .toJSON();

export default updateCommand;
