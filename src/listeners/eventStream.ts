/**
 * SSE Event Stream Listener
 *
 * Connects to MC Backend's SSE endpoint and routes events by severity:
 * - critical → owner DM (immediate attention)
 * - warning / info → suppressed from DMs (visible in MC Web Alerts tab)
 *
 * Deduplicates events within a configurable window.
 * Triggers auto-investigation (triage) for warning/critical events.
 */

import { Client, EmbedBuilder, type Message } from 'discord.js';
import { logger } from '../utils/index.js';
import {
  sseEventsReceived,
  sseConnected,
  sseDmsSent,
  sseEventsDeduplicated,
} from '../metrics/index.js';
import { EventDedup } from './eventDedup.js';
import { triageEvent, type TriageReport } from './triageHandler.js';
import { proposeRemediation } from './remediationHandler.js';
import { MissionControlClient } from '../clients/MissionControlClient.js';

export interface InfraEvent {
  id?: string;
  type: string;
  source: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  namespace?: string;
  affected_service?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

const SEVERITY_COLORS: Record<string, number> = {
  critical: 0xed4245, // red
  warning: 0xf39c12,  // orange
  info: 0x3498db,     // blue
};

const SEVERITY_LABELS: Record<string, string> = {
  critical: 'CRITICAL',
  warning: 'WARNING',
  info: 'INFO',
};

const SOURCE_COLORS: Record<string, number> = {
  kubernetes: 0x326ce5, // K8s blue
  argocd: 0xef7b4d,    // ArgoCD orange
  proxmox: 0x8b5cf6,   // Proxmox purple
};

const SOURCE_ICONS: Record<string, string> = {
  kubernetes: 'K8s',
  argocd: 'ArgoCD',
  proxmox: 'Proxmox',
};

export function buildEventEmbed(event: InfraEvent, dedupCount?: number): EmbedBuilder {
  // Use source-specific color for embed, with severity label in title
  const color = SOURCE_COLORS[event.source] ?? SEVERITY_COLORS[event.severity] ?? 0x3498db;
  const severityLabel = SEVERITY_LABELS[event.severity] ?? 'INFO';
  const sourceLabel = SOURCE_ICONS[event.source] ?? event.source;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${severityLabel} | ${sourceLabel}`)
    .setDescription(event.message)
    .setTimestamp(event.timestamp ? new Date(event.timestamp) : new Date());

  if (event.type) {
    embed.addFields({ name: 'Type', value: event.type, inline: true });
  }
  if (event.affected_service) {
    embed.addFields({ name: 'Service', value: event.affected_service, inline: true });
  }
  if (event.namespace) {
    embed.addFields({ name: 'Namespace', value: event.namespace, inline: true });
  }

  // Footer with source and dedup count
  const footerParts = [event.source];
  if (dedupCount && dedupCount > 1) {
    footerParts.push(`${dedupCount} events in last 60s`);
  }
  embed.setFooter({ text: footerParts.join(' · ') });

  return embed;
}

export function buildTriageEmbed(report: TriageReport): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2) // Discord blurple
    .setTitle('Investigation Summary')
    .setTimestamp();

  if (report.summary) {
    embed.setDescription(report.summary);
  }

  if (report.findings.length > 0) {
    const findingsText = report.findings.map((f) => `• ${f}`).join('\n');
    embed.addFields({
      name: 'Findings',
      value: findingsText.slice(0, 1024),
    });
  }

  if (report.suggestedRemediation) {
    embed.addFields({
      name: 'Suggested Action',
      value: report.suggestedRemediation,
    });
  }

  if (report.error) {
    embed.addFields({
      name: 'Note',
      value: report.error,
    });
  }

  return embed;
}

async function sendCriticalDM(
  client: Client,
  ownerUserId: string,
  event: InfraEvent,
  dedupCount?: number,
  mcClient?: MissionControlClient,
  triageTimeoutMs?: number,
): Promise<void> {
  try {
    const user = await client.users.fetch(ownerUserId);
    const dmChannel = await user.createDM();
    const embed = buildEventEmbed(event, dedupCount);
    const alertMessage: Message = await dmChannel.send({ embeds: [embed] });
    sseDmsSent.inc({ status: 'success' });

    // Auto-triage for critical events — post as threaded reply
    if (mcClient) {
      const report = await triageEvent(event, mcClient, triageTimeoutMs);
      if (report) {
        const triageEmbed = buildTriageEmbed(report);
        const triageMessage = await alertMessage.reply({ embeds: [triageEmbed] });

        // Propose remediation if triage suggests one
        if (report.remediationAction) {
          await proposeRemediation(triageMessage, event, report);
        }
      }
    }
  } catch (err) {
    sseDmsSent.inc({ status: 'failure' });
    logger.error('Failed to send event DM:', err instanceof Error ? err.message : err);
  }
}

async function handleTriageOnly(
  event: InfraEvent,
  mcClient: MissionControlClient,
  triageTimeoutMs?: number,
): Promise<void> {
  // For warning events, run triage but don't DM — results are logged
  // and will be available in MC Web Alerts tab
  const report = await triageEvent(event, mcClient, triageTimeoutMs);
  if (report) {
    logger.info(
      `[EventStream] Triage for ${event.source}/${event.type}: ${report.summary}`,
    );
  }
}

export function startEventStream(
  client: Client,
  mcBackendUrl: string,
  ownerUserId: string,
  options?: {
    dedupWindowMs?: number;
    triageTimeoutMs?: number;
    notificationServiceUrl?: string;
  },
): void {
  if (!ownerUserId) {
    logger.warn('[EventStream] No OWNER_USER_ID configured — DM alerts disabled');
    return;
  }

  const streamUrl = `${mcBackendUrl}/api/v1/events/stream`;
  const dedup = new EventDedup(options?.dedupWindowMs ?? 60_000);
  const triageTimeoutMs = options?.triageTimeoutMs ?? 10_000;
  const mcClient = new MissionControlClient(
    mcBackendUrl,
    options?.notificationServiceUrl ?? mcBackendUrl,
  );
  let retryDelay = 1000;
  const MAX_RETRY_DELAY = 30000;

  async function connect(): Promise<void> {
    logger.info(`[EventStream] Connecting to ${streamUrl}`);

    try {
      const response = await fetch(streamUrl, {
        headers: { Accept: 'text/event-stream' },
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      sseConnected.set(1);
      retryDelay = 1000;
      logger.info('[EventStream] Connected to SSE stream');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'connected') continue;

            const event = data as InfraEvent;
            sseEventsReceived.inc({
              source: event.source ?? 'unknown',
              type: event.type ?? 'unknown',
              severity: event.severity ?? 'info',
            });

            logger.info(
              `[EventStream] Event: ${event.source}/${event.type} [${event.severity}] — ${event.message}`,
            );

            // Deduplication check
            const dupEntry = dedup.isDuplicate(
              event.source,
              event.type,
              event.affected_service,
              event.namespace,
            );

            if (dupEntry) {
              sseEventsDeduplicated.inc({
                source: event.source ?? 'unknown',
                type: event.type ?? 'unknown',
              });
              logger.debug(
                `[EventStream] Deduplicated: ${event.source}/${event.type} (${dupEntry.count} in window)`,
              );
              continue;
            }

            // Severity-based routing
            switch (event.severity) {
              case 'critical':
                // DM owner + auto-triage
                await sendCriticalDM(
                  client,
                  ownerUserId,
                  event,
                  undefined,
                  mcClient,
                  triageTimeoutMs,
                );
                break;

              case 'warning':
                // No DM — triage only (results logged, visible in MC Web)
                handleTriageOnly(event, mcClient, triageTimeoutMs).catch((err) => {
                  logger.error(
                    `[EventStream] Triage error for warning event:`,
                    err instanceof Error ? err.message : err,
                  );
                });
                break;

              case 'info':
              default:
                // No DM, no triage — info events are visible in MC Web Alerts tab only
                logger.debug(`[EventStream] Info event suppressed from DM: ${event.message}`);
                break;
            }
          } catch {
            // Ignore malformed SSE data lines
          }
        }
      }

      sseConnected.set(0);
      logger.warn('[EventStream] SSE stream ended, reconnecting...');
    } catch (err) {
      sseConnected.set(0);
      logger.error(
        `[EventStream] Connection error: ${err instanceof Error ? err.message : err}`,
      );
    }

    logger.info(`[EventStream] Reconnecting in ${retryDelay / 1000}s...`);
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
  }

  connect();
}
