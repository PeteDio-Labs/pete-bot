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
 * WHY IT EDITS. One message per incident, edited in place (PET-384). Kuma's native
 * Discord provider posts DOWN and UP as unrelated messages, and this route used to post
 * a fresh DM per DOWN heartbeat on top of that. Across 19 flapping monitors that is the
 * difference between a channel you read and one you mute — and a muted channel is how
 * the outage above reached nobody. alertStore owns the grouping rules.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Client, DMChannel, EmbedBuilder as Embed } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { config } from '../../config.js';
import { logger } from '../../utils/index.js';
import { recordDown, recordUp, attachMessage, size, type AlertBatch } from '../alertStore.js';
import { alertDms, alertBatchesOpen } from '../../metrics/index.js';

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

function humanise(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  return `${hours}h${Math.round((seconds % 3600) / 60)}m`;
}

/**
 * One embed for the whole incident. A single monitor keeps the shape it always had;
 * several are listed, so a node reboot reads as one event with eight lines rather than
 * eight events.
 */
function renderBatch(batch: AlertBatch, detail: string, now = Date.now()): Embed {
  const entries = Object.entries(batch.monitors).sort(([a], [b]) => a.localeCompare(b));
  const stillDown = entries.filter(([, state]) => state.recoveredAt === undefined);
  const recovered = stillDown.length === 0;
  const single = entries.length === 1;

  const embed = new EmbedBuilder()
    .setColor(recovered ? COLOR_UP : COLOR_DOWN)
    .setTitle(
      single
        ? `${recovered ? '🟢 UP' : '🔴 DOWN'} — ${entries[0]![0]}`
        : recovered
          ? `🟢 ${entries.length} services recovered`
          : `🔴 ${stillDown.length} of ${entries.length} services down`,
    )
    .setTimestamp(new Date(now));

  const lines = entries.map(([name, state]) => {
    if (state.recoveredAt !== undefined) {
      return `🟢 **${name}** — recovered after ${humanise(Math.max(0, Math.round((state.recoveredAt - state.since) / 1000)))}`;
    }
    const bits: string[] = [];
    const seconds = Math.max(0, Math.round((now - state.since) / 1000));
    if (seconds >= 60) bits.push(`down for ${humanise(seconds)}`);
    if (state.checks > 1) bits.push(`${state.checks} checks`);
    return `🔴 **${name}**${bits.length ? ` — ${bits.join(', ')}` : ''}`;
  });

  // The probe's own message is worth showing for one monitor and unreadable for eight.
  const body = single && detail ? `${lines.join('\n')}\n\`\`\`${detail.slice(0, 900)}\`\`\`` : lines.join('\n');
  embed.setDescription(body);
  return embed;
}

async function editInPlace(dm: DMChannel, messageId: string, embed: Embed): Promise<boolean> {
  try {
    const message = await dm.messages.fetch(messageId);
    await message.edit({ embeds: [embed] });
    return true;
  } catch (err) {
    // The message was deleted, or Discord refused. Falling back to a fresh send keeps
    // the monitor audible; silently failing the edit would mute it permanently.
    logger.warn(`/v1/alert could not edit ${messageId}, sending a new message: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
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

    try {
      // ⚠ THIS IS THE LINE THE WHOLE DESIGN RESTS ON. createDM opens a DM the app did
      // not have. Discord permits it with no mutual guild and no prior contact —
      // verified 2026-09-09 against 0 guilds, which the documentation does not promise.
      // A failure here is logged loudly and returned as 502 rather than swallowed,
      // because an alert path that quietly 403s is the exact bug this route ends.
      const user = await client.users.fetch(config.discord.ownerUserId);
      const dm = (await user.createDM()) as DMChannel;

      const deliver = async (embed: Embed, batchId?: string) => {
        const sent = await dm.send({ embeds: [embed] });
        if (batchId) attachMessage(batchId, dm.id, sent.id);
        alertDms.inc({ action: 'sent', status: 'success' });
        alertBatchesOpen.set(size());
        res.json({ ok: true, action: 'sent', monitor, channelId: dm.id, messageId: sent.id });
      };

      if (down) {
        const { batch, action } = recordDown(monitor);
        const embed = renderBatch(batch, detail);
        if (action === 'edit' && batch.messageId && (await editInPlace(dm, batch.messageId, embed))) {
          alertDms.inc({ action: 'edited', status: 'success' });
          alertBatchesOpen.set(size());
          res.json({ ok: true, action: 'edited', monitor, messageId: batch.messageId });
          return;
        }
        await deliver(embed, batch.id);
        return;
      }

      if (up) {
        const { batch } = recordUp(monitor);
        if (batch?.messageId) {
          const embed = renderBatch(batch, detail);
          if (await editInPlace(dm, batch.messageId, embed)) {
            alertDms.inc({ action: 'edited', status: 'success' });
            alertBatchesOpen.set(size());
            res.json({ ok: true, action: 'edited', monitor, messageId: batch.messageId });
            return;
          }
        }
        // A recovery for an outage this process never saw — a restart with no state
        // path, most often. Say it plainly rather than dropping it.
        const embed = new EmbedBuilder()
          .setColor(COLOR_UP)
          .setTitle(`🟢 UP — ${monitor}`)
          .setTimestamp(new Date());
        if (detail) embed.setDescription(`\`\`\`${detail.slice(0, 900)}\`\`\``);
        await deliver(embed);
        return;
      }

      // PENDING and MAINTENANCE are neither an outage nor a recovery, so they are not
      // grouped and never edit an incident.
      const embed = new EmbedBuilder()
        .setColor(COLOR_OTHER)
        .setTitle(`🟡 ${monitor}`)
        .setTimestamp(new Date());
      if (detail) embed.setDescription(`\`\`\`${detail.slice(0, 900)}\`\`\``);
      await deliver(embed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      alertDms.inc({ action: down ? 'sent' : 'edited', status: 'failure' });
      logger.error(`/v1/alert could not DM the owner: ${message}`);
      res.status(502).json({ error: 'discord delivery failed', detail: message.slice(0, 300) });
    }
  };
}

export default createAlertHandler;
