// Interaction event handler - routes commands to handlers
import type { Interaction } from 'discord.js';
import type { OllamaClient } from '../ai/OllamaClient.js';
import { handleAskCommand, handleInfoCommand, handleToolsCommand, handleHelpCommand } from '../commands/handlers/index.js';
import { discordMessagesProcessed, discordRequestDuration } from '../metrics/index.js';
import { logger } from '../utils/index.js';

export function createInteractionHandler(
  ollamaClient: OllamaClient,
  allowedUsers: string[]
): (interaction: Interaction) => Promise<void> {
  return async function handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const startTime = Date.now();
    let status: 'success' | 'error' = 'success';

    try {
      switch (commandName) {
        case 'ask':
          await handleAskCommand(interaction, ollamaClient, allowedUsers);
          break;
        case 'info':
          await handleInfoCommand(interaction, ollamaClient, allowedUsers);
          break;
        case 'tools':
          await handleToolsCommand(interaction);
          break;
        case 'help':
          await handleHelpCommand(interaction);
          break;
        default:
          logger.warn(`Unknown command: ${commandName}`);
          status = 'error';
      }
    } catch (error) {
      status = 'error';
      throw error;
    } finally {
      // Record metrics
      const duration = (Date.now() - startTime) / 1000;
      discordMessagesProcessed.labels(commandName, status).inc();
      discordRequestDuration.labels(commandName).observe(duration);
    }
  };
}

export default createInteractionHandler;
