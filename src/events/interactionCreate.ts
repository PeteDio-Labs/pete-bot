// Interaction event handler — routes slash commands to handlers
import type { Interaction } from 'discord.js';
import { handleHelpCommand } from '../commands/handlers/index.js';
import { discordMessagesProcessed, discordRequestDuration } from '../metrics/index.js';
import { logger } from '../utils/index.js';

export function createInteractionHandler(): (interaction: Interaction) => Promise<void> {
  return async function handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const startTime = Date.now();
    let status: 'success' | 'error' = 'success';

    try {
      if (commandName === 'help') {
        await handleHelpCommand(interaction);
      } else {
        logger.warn(`Unknown command: ${commandName}`);
        status = 'error';
      }
    } catch (error) {
      status = 'error';
      throw error;
    } finally {
      const duration = (Date.now() - startTime) / 1000;
      discordMessagesProcessed.labels(commandName, status).inc();
      discordRequestDuration.labels(commandName).observe(duration);
    }
  };
}

export default createInteractionHandler;
