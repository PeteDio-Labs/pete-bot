/**
 * POST /v1/notify (PB.6).
 *
 * Receives a Plan notification from MC Backend (services/notifications/router.ts).
 * Renders the Discord embed + buttons and posts to config.discord.notifyChannelId.
 * Records the posted (channelId, messageId) in messageCache so /v1/edit-message
 * can update it later.
 *
 * Stateless — every payload includes the full plan + actions + expires_at +
 * mcUrl. No server-side plan state in Pete Bot.
 *
 * Auth: HMAC verified by middleware before this handler runs.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Client, TextChannel } from 'discord.js';
import { config } from '../../config.js';
import { logger } from '../../utils/index.js';
import { buildPlanEmbed, buildActionRows, type NotifyPlan } from '../discordRenderer.js';
import { rememberMessage } from '../messageCache.js';

// ─── Body schema ───────────────────────────────────────────────────────

const ActionSchema = z.object({
  actionId: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  style: z.enum(['primary', 'secondary', 'danger', 'link']),
});

const NotifyBodySchema = z.object({
  planId: z.string().regex(/^pl_[a-zA-Z0-9_-]{4,64}$/),
  kind: z.string().min(1).max(64),
  severity: z.enum(['info', 'warn', 'error', 'critical']),
  source: z.string().min(1).max(64),
  target: z.string().nullable(),
  summary: z.string().min(1).max(2000),
  expiresAt: z.string().datetime().nullable(),
  mcUrl: z.string().url(),
  buttonsEnabled: z.boolean(),
  actions: z.array(ActionSchema).min(0).max(8),
});

// ─── Handler factory ───────────────────────────────────────────────────
// Factory pattern lets us inject the Discord client (avoids module-level
// singleton coupling, makes the handler testable).

export function createNotifyHandler(client: Client) {
  return async function notifyHandler(req: Request, res: Response): Promise<void> {
    const parsed = NotifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', details: parsed.error.issues });
      return;
    }
    const plan: NotifyPlan = parsed.data;

    const channelId = config.discord.notifyChannelId;
    if (!channelId) {
      logger.error('NOTIFY_CHANNEL_ID unset — cannot post Plan');
      res.status(500).json({ error: 'server_misconfigured', reason: 'notify_channel_unset' });
      return;
    }

    let channel: TextChannel;
    try {
      const fetched = await client.channels.fetch(channelId);
      if (!fetched || !fetched.isTextBased() || fetched.isDMBased()) {
        res.status(500).json({ error: 'channel_not_text', channelId });
        return;
      }
      channel = fetched as TextChannel;
    } catch (err) {
      logger.error('Failed to fetch notify channel', { channelId, error: (err as Error).message });
      res.status(500).json({ error: 'channel_fetch_failed', detail: (err as Error).message });
      return;
    }

    try {
      const embed = buildPlanEmbed(plan);
      const components = buildActionRows(plan);
      const message = await channel.send({ embeds: [embed], components });

      rememberMessage(plan.planId, channel.id, message.id);

      logger.info('Plan posted to Discord', {
        planId: plan.planId,
        kind: plan.kind,
        severity: plan.severity,
        channelId: channel.id,
        messageId: message.id,
        actionCount: plan.actions.length,
        buttonsEnabled: plan.buttonsEnabled,
      });

      res.status(201).json({
        ok: true,
        channelId: channel.id,
        messageId: message.id,
      });
    } catch (err) {
      logger.error('Failed to post Plan to Discord', {
        planId: plan.planId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: 'discord_post_failed', detail: (err as Error).message });
    }
  };
}
