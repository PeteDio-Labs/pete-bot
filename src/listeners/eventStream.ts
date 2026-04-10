/**
 * SSE Event Stream Listener
 *
 * Connects to MC Backend's SSE endpoint and DMs the owner on:
 * - critical events: immediate alert
 * - warning events: alert
 * - agent source events: investigation/remediation results
 *
 * Info events are suppressed from DMs — visible in MC Web Alerts tab.
 * Simple in-process dedup prevents duplicate DMs within the window.
 */

import { Client, EmbedBuilder } from 'discord.js';
import type { InfraEvent } from '@petedio/shared';
import { SseListener } from '@petedio/shared';
import { logger } from '../utils/index.js';
import { sseEventsReceived, sseConnected, sseDmsSent, sseEventsDeduplicated } from '../metrics/index.js';

export type { InfraEvent };

const SEVERITY_COLORS: Record<string, number> = {
  critical: 0xed4245, // red
  warning: 0xf39c12,  // orange
  info: 0x3498db,     // blue
};

const SOURCE_COLORS: Record<string, number> = {
  kubernetes: 0x326ce5, // K8s blue
  argocd: 0xef7b4d,    // ArgoCD orange
  proxmox: 0x8b5cf6,   // Proxmox purple
  agent: 0x5865f2,     // Discord blurple for agent results
};

const SOURCE_ICONS: Record<string, string> = {
  kubernetes: 'K8s',
  argocd: 'ArgoCD',
  proxmox: 'Proxmox',
  agent: 'Agent',
};

export function buildEventEmbed(event: InfraEvent): EmbedBuilder {
  const color = SOURCE_COLORS[event.source] ?? SEVERITY_COLORS[event.severity] ?? 0x3498db;
  const sourceLabel = SOURCE_ICONS[event.source] ?? event.source;
  const severityLabel = event.severity.toUpperCase();

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${severityLabel} | ${sourceLabel}`)
    .setDescription(event.message)
    .setTimestamp(event.timestamp ? new Date(event.timestamp) : new Date())
    .setFooter({ text: event.source });

  if (event.type) embed.addFields({ name: 'Type', value: event.type, inline: true });
  if (event.affected_service) embed.addFields({ name: 'Service', value: event.affected_service, inline: true });
  if (event.namespace) embed.addFields({ name: 'Namespace', value: event.namespace, inline: true });

  return embed;
}

async function sendDM(client: Client, ownerUserId: string, event: InfraEvent): Promise<void> {
  try {
    const user = await client.users.fetch(ownerUserId);
    const dmChannel = await user.createDM();
    await dmChannel.send({ embeds: [buildEventEmbed(event)] });
    sseDmsSent.inc({ status: 'success' });
  } catch (err) {
    sseDmsSent.inc({ status: 'failure' });
    logger.error('Failed to send DM:', err instanceof Error ? err.message : err);
  }
}

export function startEventStream(
  client: Client,
  mcBackendUrl: string,
  ownerUserId: string,
  options?: { dedupWindowMs?: number },
): void {
  if (!ownerUserId) {
    logger.warn('[EventStream] No OWNER_USER_ID configured — DM alerts disabled');
    return;
  }

  const streamUrl = `${mcBackendUrl}/api/v1/events/stream`;
  const dedupWindowMs = options?.dedupWindowMs ?? 60_000;

  // Simple in-process dedup: key → timestamp of last seen
  const seen = new Map<string, number>();

  const sse = new SseListener(streamUrl, {
    onConnect: () => {
      sseConnected.set(1);
      logger.info('[EventStream] Connected to MC Backend SSE');
    },
    onDisconnect: () => {
      sseConnected.set(0);
      logger.warn('[EventStream] SSE disconnected — reconnecting...');
    },
    onError: (err: unknown) => {
      logger.error(`[EventStream] Error: ${err instanceof Error ? err.message : err}`);
    },
    onEvent: (data: unknown) => {
      if ((data as { type?: string }).type === 'connected') return;

      const event = data as InfraEvent;
      sseEventsReceived.inc({
        source: event.source ?? 'unknown',
        type: event.type ?? 'unknown',
        severity: event.severity ?? 'info',
      });

      logger.info(
        `[EventStream] ${event.source}/${event.type} [${event.severity}] — ${event.message}`,
      );

      // Dedup: skip same source+type+service within window
      const key = `${event.source}:${event.type}:${event.affected_service ?? ''}`;
      const last = seen.get(key);
      if (last && Date.now() - last < dedupWindowMs) {
        sseEventsDeduplicated.inc({ source: event.source ?? 'unknown', type: event.type ?? 'unknown' });
        logger.debug(`[EventStream] Deduplicated: ${key}`);
        return;
      }
      seen.set(key, Date.now());

      // DM owner on critical/warning events and all agent results
      const shouldDM =
        event.severity === 'critical' ||
        event.severity === 'warning' ||
        event.source === 'agent';

      if (shouldDM) {
        void sendDM(client, ownerUserId, event);
      }
    },
  });

  sse.start();
}
