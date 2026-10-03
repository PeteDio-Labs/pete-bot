/**
 * POST /v1/notify — put one free-text message in the owner's DM (PET-579).
 *
 * WHY THIS EXISTS. /v1/alert is the only other way in, and it takes an Uptime Kuma
 * webhook. A session that wants Pedro's attention would have to pose as a monitor: its
 * message would arrive as a red DOWN embed and add incident state that never recovers.
 * This route sends the text and records nothing.
 *
 * WHY ITS OWN TOKEN (PET-584). This route is the first way every session reaches Pedro,
 * so its token sits on claude-247 and codex-248, readable by their session users. Those
 * sessions must not be able to post a fake DOWN alert, so NOTIFY_BEARER_TOKEN opens this
 * route alone, and ALERT_BEARER_TOKEN stays with Uptime Kuma. Neither opens the other's
 * route. The route shipped on the alert token in PET-579, and PET-584 split it.
 *
 * WHY `content` AND NOT AN EMBED. Pedro reads this on a phone, and the notification
 * preview shows a message's content. The sender's name leads the first line, so the
 * preview says who is talking.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Client, DMChannel } from 'discord.js';
import { config } from '../../config.js';
import { logger } from '../../utils/index.js';

// Discord caps message content at 2000 characters. The header takes at most 105 of them
// (`**` + 100 + `**` + a newline), so the message gets the rest with room to spare.
const NotifySchema = z.object({
  from: z.string().trim().min(1).max(100),
  message: z.string().trim().min(1).max(1800),
});

export function createNotifyHandler(client: Client) {
  return async function notifyHandler(req: Request, res: Response): Promise<void> {
    // The bearer check /v1/alert uses, against this route's own token.
    const expected = config.httpServer.notifyToken;
    const got = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!expected || got.length !== expected.length || got !== expected) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const parsed = NotifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad payload', detail: parsed.error.issues.slice(0, 3) });
      return;
    }

    const { from, message } = parsed.data;
    try {
      const user = await client.users.fetch(config.discord.ownerUserId);
      const dm = (await user.createDM()) as DMChannel;
      // A sender can type anything, so no mention in it may ping anyone.
      const sent = await dm.send({ content: `**${from}**\n${message}`, allowedMentions: { parse: [] } });
      // Log who and which message, never the body: it is a private note to Pedro.
      logger.info(`/v1/notify delivered a message from ${from} as ${sent.id}`);
      res.json({ ok: true, action: 'sent', channelId: dm.id, messageId: sent.id });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error(`/v1/notify could not DM the owner: ${detail}`);
      res.status(502).json({ error: 'discord delivery failed', detail: detail.slice(0, 300) });
    }
  };
}

export default createNotifyHandler;
