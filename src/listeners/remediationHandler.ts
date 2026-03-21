/**
 * Remediation Handler
 *
 * Proposes fix actions based on triage reports, creates Discord buttons,
 * and executes approved remediations via MC Backend.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type Client,
} from 'discord.js';
import { RemediationDB, type RemediationTask } from '../db/remediations.js';
import { MissionControlClient } from '../clients/MissionControlClient.js';
import { remediationTasksTotal } from '../metrics/index.js';
import { logger } from '../utils/index.js';
import type { TriageReport } from './triageHandler.js';
import type { InfraEvent } from './eventStream.js';

let remediationDb: RemediationDB | null = null;

export function initRemediationDB(dbPath?: string): RemediationDB {
  if (!remediationDb) {
    remediationDb = new RemediationDB(dbPath);
    // Expire stale tasks every minute
    setInterval(() => {
      const expired = remediationDb!.expireStale();
      if (expired > 0) {
        logger.info(`[Remediation] Expired ${expired} stale pending tasks`);
      }
    }, 60_000);
  }
  return remediationDb;
}

export function getRemediationDB(): RemediationDB | null {
  return remediationDb;
}

/**
 * Propose a remediation action to the user via Discord buttons.
 * Posts the triage report embed with Approve/Reject buttons.
 */
export async function proposeRemediation(
  alertMessage: Message,
  event: InfraEvent,
  report: TriageReport,
): Promise<void> {
  if (!report.remediationAction || !remediationDb) return;

  const service = event.affected_service ?? '';

  // Safety: max 1 active remediation per service
  if (remediationDb.hasActiveForService(service)) {
    logger.info(
      `[Remediation] Skipping proposal — active remediation exists for ${service}`,
    );
    return;
  }

  const task = remediationDb.create({
    eventId: event.id ?? '',
    action: report.remediationAction,
    actionParams: report.remediationParams ?? {},
    affectedService: service,
  });

  remediationTasksTotal.inc({ action: task.action, state: 'pending' });

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`remediation_approve_${task.id}`)
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`remediation_reject_${task.id}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`remediation_investigate_${task.id}`)
      .setLabel('Investigate More')
      .setStyle(ButtonStyle.Primary),
  );

  const proposalEmbed = new EmbedBuilder()
    .setColor(0x57f287) // green
    .setTitle('Remediation Proposal')
    .setDescription(report.suggestedRemediation ?? 'No remediation suggested.')
    .addFields(
      { name: 'Action', value: `\`${task.action}\``, inline: true },
      {
        name: 'Parameters',
        value:
          Object.entries(task.params)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n') || 'None',
        inline: true,
      },
    )
    .setFooter({ text: `Task ${task.id.slice(0, 8)} · Expires in 15 min` })
    .setTimestamp();

  const reply = await alertMessage.reply({
    embeds: [proposalEmbed],
    components: [buttons],
  });

  // Store the Discord message ID so button handler can look up the task
  remediationDb.setDiscordMessageId(task.id, reply.id);
}

/**
 * Execute an approved remediation task.
 */
export async function executeRemediation(
  task: RemediationTask,
  mcClient: MissionControlClient,
  client: Client,
  ownerUserId: string,
): Promise<void> {
  remediationDb?.updateState(task.id, 'executing');
  remediationTasksTotal.inc({ action: task.action, state: 'executing' });

  try {
    let resultMessage: string;

    switch (task.action) {
      case 'sync_app': {
        const appName = task.params.name ?? '';
        const { data } = await mcClient.syncArgoApp(appName);
        resultMessage = data.success
          ? `Synced ${appName} successfully.`
          : `Sync failed: ${data.error ?? data.message ?? 'unknown error'}`;
        break;
      }
      case 'restart_deployment': {
        const ns = task.params.namespace ?? 'default';
        const deployName = task.params.name ?? '';
        const { data } = await mcClient.restartDeployment(ns, deployName);
        resultMessage = data.success
          ? `Restarted ${deployName} in ${ns}.`
          : `Restart failed: ${data.error ?? data.message ?? 'unknown error'}`;
        break;
      }
      default:
        resultMessage = `Unknown action: ${task.action}`;
    }

    remediationDb?.updateState(task.id, 'complete', { result: resultMessage });
    remediationTasksTotal.inc({ action: task.action, state: 'complete' });

    // Notify owner of result
    await notifyOwner(client, ownerUserId, task, resultMessage, true);

    // Publish remediation event back to notification-service for audit trail
    await publishRemediationEvent(mcClient, task, resultMessage);

    logger.info(`[Remediation] ${task.action} completed: ${resultMessage}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    remediationDb?.updateState(task.id, 'failed', { result: errorMsg });
    remediationTasksTotal.inc({ action: task.action, state: 'failed' });

    await notifyOwner(client, ownerUserId, task, errorMsg, false);
    logger.error(`[Remediation] ${task.action} failed: ${errorMsg}`);
  }
}

async function notifyOwner(
  client: Client,
  ownerUserId: string,
  task: RemediationTask,
  result: string,
  success: boolean,
): Promise<void> {
  try {
    const user = await client.users.fetch(ownerUserId);
    const dmChannel = await user.createDM();

    const embed = new EmbedBuilder()
      .setColor(success ? 0x57f287 : 0xed4245)
      .setTitle(success ? 'Remediation Complete' : 'Remediation Failed')
      .setDescription(result)
      .addFields({ name: 'Action', value: `\`${task.action}\``, inline: true })
      .setFooter({ text: `Task ${task.id.slice(0, 8)}` })
      .setTimestamp();

    await dmChannel.send({ embeds: [embed] });
  } catch (err) {
    logger.error(
      '[Remediation] Failed to notify owner:',
      err instanceof Error ? err.message : err,
    );
  }
}

async function publishRemediationEvent(
  mcClient: MissionControlClient,
  task: RemediationTask,
  result: string,
): Promise<void> {
  try {
    await mcClient.publishEvent({
      source: 'pete-bot',
      type: 'remediation',
      severity: 'info',
      message: `Remediation ${task.action} for ${task.affected_service}: ${result}`,
      affected_service: task.affected_service,
      metadata: {
        task_id: task.id,
        action: task.action,
        params: task.params,
      },
    });
  } catch (err) {
    logger.warn(
      '[Remediation] Failed to publish audit event:',
      err instanceof Error ? err.message : err,
    );
  }
}
