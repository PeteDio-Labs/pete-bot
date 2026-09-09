/**
 * POST /v1/alert — take an Uptime Kuma webhook and put it in the owner's DM.
 *
 * WHY THIS EXISTS. Kuma watched 19 services and could reach nobody: 0 notification
 * channels, 0 attachments. On 2026-09-09 it logged 1724 consecutive DOWN heartbeats
 * across a nine-and-a-half-hour Vault outage and told no one (PET-374).
 *
 * WHY NOT /v1/notify. That route's schema wants a `pl_` planId and an `mcUrl` from a
 * Mission Control that no longer exists, and it is HMAC-gated. Kuma's generic webhook
 * cannot sign a body, so it could never satisfy either. This route takes Kuma's own
 * shape and authenticates with a bearer token, which is the strongest thing the sender
 * can actually produce.
 *
 * WHY IT EDITS. Keyed on the monitor name, a recovery edits the original DM rather than
 * posting a second message. Kuma's native Discord provider posts DOWN and UP as
 * unrelated messages; across 19 flapping monitors that is the difference between a
 * channel you read and one you mute.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Client } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { config } from '../../config.js';
import { logger } from '../../utils/index.js';
import { rememberMessage, lookupMessage, forgetMessage } from '../messageCache.js';
import { sseDmsSent } from '../../metrics/index.js';

// Kuma sends more than this; only these are depended on, and unknown keys are
// ignored rather than rejected so a Kuma upgrade cannot break alerting.
const AlertSchema = z.object({
  heartbeat: z
    .object({
      // 0 DOWN, 1 UP, 2 PENDING, 3 MAINTENANCE.
      status: z.number().int().optional(),
      msg: z.string().optional(),
      time: z.string().optional(),
    })
    .optional(),
  monitor: z.object({ name: z.string().min(1).max(200) }).optional(),
  msg: z.string().max(2000).optional(),
});

const COLOR_DOWN = 0xed4245;
const COLOR_UP = 0x57f287;
const COLOR_OTHER = 0xfee75c;

function cacheKey(monitor: string): string {
  return `kuma:${monitor}`;
}

export function createAlertHandler(client: Client) {
  return async function alertHandler(req: Request, res: Response): Promise<void> {
    // ⚠ Bearer, not HMAC — see the module docstring. Compared with a length check
    // first so a wrong-length token cannot be distinguished by timing alone.
    const expected = config.httpServer.alertToken;
    const got = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!expected || got.length !== expected.length || got !== expected) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const parsed = AlertSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad payload', detail: parsed.error.issues.slice(0, 3) });
      return;
    }

    const monitor = parsed.data.monitor?.name ?? 'unknown monitor';
    const status = parsed.data.heartbeat?.status;
    const detail = parsed.data.heartbeat?.msg ?? parsed.data.msg ?? '';
    const down = status === 0;
    const up = status === 1;

    const embed = new EmbedBuilder()
      .setColor(down ? COLOR_DOWN : up ? COLOR_UP : COLOR_OTHER)
      .setTitle(`${down ? '🔴 DOWN' : up ? '🟢 UP' : '🟡'} — ${monitor}`)
      .setTimestamp(new Date());
    if (detail) embed.setDescription(`\`\`\`${detail.slice(0, 1000)}\`\`\``);

    try {
      // ⚠ THIS IS THE LINE THE WHOLE DESIGN RESTS ON. createDM opens a DM the app did
      // not have; Discord permits it after user-initiated contact and refuses it with
      // 50007 otherwise. A user-installed app that Pedro has opened a DM with satisfies
      // that — but it is an assumption until this succeeds with no mutual guild, which
      // is the test PET-375 exists to run. A failure here is logged loudly and returned
      // as 502 rather than swallowed, because an alert path that quietly 403s is the
      // exact bug this route was built to end.
      const user = await client.users.fetch(config.discord.ownerUserId);
      const dm = await user.createDM();

      const prior = up ? lookupMessage(cacheKey(monitor)) : undefined;
      if (prior) {
        const message = await dm.messages.fetch(prior.messageId);
        await message.edit({ embeds: [embed] });
        forgetMessage(cacheKey(monitor));
        sseDmsSent.inc({ status: 'success' });
        res.json({ ok: true, action: 'edited', monitor });
        return;
      }

      const sent = await dm.send({ embeds: [embed] });
      if (down) rememberMessage(cacheKey(monitor), dm.id, sent.id);
      sseDmsSent.inc({ status: 'success' });
      res.json({ ok: true, action: 'sent', monitor, channelId: dm.id, messageId: sent.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sseDmsSent.inc({ status: 'failure' });
      logger.error(`/v1/alert could not DM the owner: ${message}`);
      res.status(502).json({ error: 'discord delivery failed', detail: message.slice(0, 300) });
    }
  };
}

export default createAlertHandler;
