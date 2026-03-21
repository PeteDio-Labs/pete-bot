/**
 * Discord Button Interaction Handler
 *
 * Handles Approve/Reject/Investigate button clicks for remediation proposals.
 * Only the owner can approve — silently ignores other users.
 */

import type { ButtonInteraction, Client } from 'discord.js';
import { getRemediationDB } from './remediationHandler.js';
import { executeRemediation } from './remediationHandler.js';
import { MissionControlClient } from '../clients/MissionControlClient.js';
import { remediationTasksTotal } from '../metrics/index.js';
import { logger } from '../utils/index.js';

export function createButtonHandler(
  ownerUserId: string,
  mcClient: MissionControlClient,
) {
  return async function handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;

    // Only handle remediation buttons
    if (!customId.startsWith('remediation_')) return;

    const parts = customId.split('_');
    // Format: remediation_{action}_{taskId}
    const action = parts[1]; // approve, reject, investigate
    const taskId = parts.slice(2).join('_'); // UUID

    const db = getRemediationDB();
    if (!db) {
      await interaction.reply({ content: 'Remediation system not initialized.', ephemeral: true });
      return;
    }

    const task = db.getById(taskId);
    if (!task) {
      await interaction.reply({ content: 'Task not found or expired.', ephemeral: true });
      return;
    }

    // Only owner can approve
    if (interaction.user.id !== ownerUserId) {
      await interaction.reply({
        content: 'Only the owner can approve or reject remediations.',
        ephemeral: true,
      });
      return;
    }

    switch (action) {
      case 'approve': {
        if (task.state !== 'pending') {
          await interaction.reply({
            content: `Task is already ${task.state}.`,
            ephemeral: true,
          });
          return;
        }

        db.updateState(taskId, 'approved', { resolvedBy: interaction.user.id });
        remediationTasksTotal.inc({ action: task.action, state: 'approved' });

        await interaction.update({
          content: `Approved — executing \`${task.action}\`...`,
          components: [], // Remove buttons
        });

        logger.info(`[Button] Remediation approved: ${task.action} (${taskId.slice(0, 8)})`);

        // Execute async — don't block the interaction
        executeRemediation(
          task,
          mcClient,
          interaction.client as Client,
          ownerUserId,
        ).catch((err) => {
          logger.error('[Button] Remediation execution error:', err);
        });
        break;
      }

      case 'reject': {
        if (task.state !== 'pending') {
          await interaction.reply({
            content: `Task is already ${task.state}.`,
            ephemeral: true,
          });
          return;
        }

        db.updateState(taskId, 'rejected', { resolvedBy: interaction.user.id });
        remediationTasksTotal.inc({ action: task.action, state: 'rejected' });

        await interaction.update({
          content: `Rejected — \`${task.action}\` will not be executed.`,
          components: [],
        });

        logger.info(`[Button] Remediation rejected: ${task.action} (${taskId.slice(0, 8)})`);
        break;
      }

      case 'investigate': {
        await interaction.reply({
          content: `Use \`/ask\` to investigate further: "What's going on with ${task.affected_service}?"`,
          ephemeral: true,
        });
        break;
      }

      default:
        await interaction.reply({ content: 'Unknown action.', ephemeral: true });
    }
  };
}
