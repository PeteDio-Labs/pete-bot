// Interaction event handler - routes commands and button interactions to handlers
import type { Interaction, ButtonInteraction } from 'discord.js';
import type { OllamaClient } from '../ai/OllamaClient.js';
import { handleAskCommand, handleInfoCommand, handleToolsCommand, handleHelpCommand, handleCodeCommand } from '../commands/handlers/index.js';
import { discordMessagesProcessed, discordRequestDuration } from '../metrics/index.js';
import { logger } from '../utils/index.js';

type ButtonHandler = (interaction: ButtonInteraction) => Promise<void>;

export function createInteractionHandler(
  ollamaClient: OllamaClient,
  allowedUsers: string[],
  buttonHandler?: ButtonHandler,
  coderConfig?: { host: string; model: string },
): (interaction: Interaction) => Promise<void> {
  return async function handleInteraction(interaction: Interaction): Promise<void> {
    // Handle button interactions (remediation approve/reject)
    if (interaction.isButton()) {
      if (buttonHandler) {
        try {
          await buttonHandler(interaction);
        } catch (err) {
          logger.error('Button handler error:', err);
        }
      }
      return;
    }

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
        case 'code':
          await handleCodeCommand(
            interaction,
            coderConfig?.host ?? 'http://localhost:11434',
            coderConfig?.model ?? 'petedio-coder',
            allowedUsers,
          );
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
