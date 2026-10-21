/**
 * POST /v1/alert — take an Uptime Kuma webhook and put it in the owner's DM.
 *
 * WHY THIS EXISTS. Kuma watched 19 services and could reach nobody: 0 notification
 * channels, 0 attachments. On 2026-09-09 it logged 1724 consecutive DOWN heartbeats
 * across a nine-and-a-half-hour Vault outage and told no one (PET-374).
 *
 * WHY NOT THE OLD /v1/notify. That route's schema wanted a `pl_` planId and an `mcUrl` from a
 * Mission Control that no longer exists, and it is HMAC-gated. Kuma's generic webhook
 * cannot sign a body, so it could never satisfy either. This route takes Kuma's own
 * shape and authenticates with a bearer token, which is the strongest thing the sender
 * can actually produce. (PET-579 later reused the name for an unrelated free-text route.)
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
import {
  recordDown,
  recordUp,
  foldOrphanUp,
  attachMessage,
  size,
  isInBatch,
  getHold,
  addHold,
  takeHold,
  activeHolds,
  setNote,
  type AlertBatch,
} from '../alertStore.js';
import { alertDms, alertBatchesOpen, alertDecisions } from '../../metrics/index.js';
import { scheduleDecider, type MaintenanceDecider } from '../decider.js';
import { addSample, deadlineMs, stats } from '../baseline.js';

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
      // PET-436: no DOWN reached this process, so there is no outage length to report.
      if (state.unseenDown) return `🟢 **${name}** — recovered`;
      return `🟢 **${name}** — recovered after ${humanise(Math.max(0, Math.round((state.recoveredAt - state.since) / 1000)))}`;
    }
    const bits: string[] = [];
    const seconds = Math.max(0, Math.round((now - state.since) / 1000));
    if (seconds >= 60) bits.push(`down for ${humanise(seconds)}`);
    if (state.checks > 1) bits.push(`${state.checks} checks`);
    return `🔴 **${name}**${bits.length ? ` — ${bits.join(', ')}` : ''}${state.note ? `\n${state.note}` : ''}`;
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

/** When Kuma's heartbeat time parses, the decider reads it; otherwise the receipt time. Kuma runs TZ=UTC. */
function heartbeatTime(raw: string | undefined, receivedAt: number): Date {
  if (!raw) return new Date(receivedAt);
  const parsed = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? new Date(receivedAt) : parsed;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

export function createAlertHandler(client: Client, decider: MaintenanceDecider = scheduleDecider(config.alerts.maintenanceWindows)) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** The DM path for a DOWN, shared by a normal DOWN and a held one whose deadline passed. */
  async function sendDown(dm: DMChannel, monitor: string, detail: string, note?: string) {
    const { batch, action } = recordDown(monitor);
    if (note) setNote(batch.id, monitor, note);
    const embed = renderBatch(batch, detail);
    if (action === 'edit' && batch.messageId && (await editInPlace(dm, batch.messageId, embed))) {
      alertDms.inc({ action: 'edited', status: 'success' });
      alertBatchesOpen.set(size());
      return { action: 'edited' as const, messageId: batch.messageId };
    }
    const sent = await dm.send({ embeds: [embed] });
    attachMessage(batch.id, dm.id, sent.id);
    alertDms.inc({ action: 'sent', status: 'success' });
    alertBatchesOpen.set(size());
    return { action: 'sent' as const, messageId: sent.id };
  }

  /** The deadline passed with no UP: send the DM as an ordinary DOWN, with the extra line. */
  async function expire(monitor: string): Promise<void> {
    timers.delete(monitor);
    const hold = takeHold(monitor);
    if (!hold) return;
    const s = stats(monitor);
    const usual = s ? `usually back in ${seconds(s.meanMs)} ± ${seconds(s.sdMs)} (${s.n} nights)` : 'no recovery history yet';
    const note = `↳ held in ${hold.window}; ${usual}; the ${seconds(hold.deadlineAt - hold.since)} deadline passed`;
    logger.info(`[alert] decision=deadline monitor=${monitor} window="${hold.window}" deadlineMs=${hold.deadlineAt - hold.since} outcome=alerted`);
    alertDecisions.inc({ decision: 'deadline', outcome: 'alerted' });
    try {
      const user = await client.users.fetch(config.discord.ownerUserId);
      const dm = (await user.createDM()) as DMChannel;
      await sendDown(dm, monitor, hold.detail, note);
    } catch (err) {
      // Fail open: a hold that cannot DM is retried by the next DOWN heartbeat, which no
      // longer finds a hold and takes the ordinary path.
      alertDecisions.inc({ decision: 'deadline', outcome: 'error' });
      logger.error(`[alert] held DOWN for ${monitor} passed its deadline and the DM failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function arm(monitor: string, deadlineAt: number): void {
    clearTimeout(timers.get(monitor));
    const timer = setTimeout(() => void expire(monitor), Math.max(0, deadlineAt - Date.now()));
    timer.unref?.();
    timers.set(monitor, timer);
  }

  // Restart while holding: a deadline already past sends at once (arm clamps to 0).
  for (const hold of activeHolds()) arm(hold.monitor, hold.deadlineAt);

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
        // PET-492: a DOWN that starts inside a maintenance window is held, not sent. A
        // monitor already in an open batch or already held skips the decision, and any error
        // in it falls through to today's path: fail open, never mute an outage.
        try {
          const received = Date.now();
          const held = getHold(monitor);
          if (held) {
            res.json({ ok: true, action: 'held', monitor });
            return;
          }
          const window = isInBatch(monitor) ? null : decider.isMaintenance(heartbeatTime(parsed.data.heartbeat?.time, received));
          if (window) {
            const wait = deadlineMs(monitor);
            addHold({ monitor, since: received, deadlineAt: received + wait, window, detail });
            arm(monitor, received + wait);
            logger.info(`[alert] decision=held monitor=${monitor} window="${window}" heartbeat=${parsed.data.heartbeat?.time ?? 'none'} deadlineMs=${wait}`);
            alertDecisions.inc({ decision: 'held', outcome: 'pending' });
            res.json({ ok: true, action: 'held', monitor, deadlineMs: wait });
            return;
          }
        } catch (err) {
          alertDecisions.inc({ decision: 'held', outcome: 'error' });
          logger.error(`[alert] maintenance decision failed for ${monitor}, alerting as usual: ${err instanceof Error ? err.message : String(err)}`);
        }
        const sent = await sendDown(dm, monitor, detail);
        res.json({ ok: true, action: sent.action, monitor, channelId: dm.id, messageId: sent.messageId });
        return;
      }

      if (up) {
        // A held DOWN that recovers before its deadline is released with no DM, and its
        // recovery time trains the deadline.
        const hold = takeHold(monitor);
        if (hold) {
          clearTimeout(timers.get(monitor));
          timers.delete(monitor);
          const took = Date.now() - hold.since;
          try {
            addSample(monitor, took);
          } catch (err) {
            logger.error(`[alert] cannot record the recovery of ${monitor}: ${err instanceof Error ? err.message : String(err)}`);
          }
          logger.info(`[alert] decision=released monitor=${monitor} window="${hold.window}" recoveryMs=${took} outcome=recovered`);
          alertDecisions.inc({ decision: 'released', outcome: 'recovered' });
          res.json({ ok: true, action: 'released', monitor, recoveryMs: took });
          return;
        }

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
        // A recovery for an outage this process never saw (PET-436). Fold it into the open
        // or most recent incident message, or open one message that the rest of the burst
        // folds into, instead of posting a DM per monitor.
        const orphan = batch ? null : foldOrphanUp(monitor);
        if (orphan && !orphan.isNew && orphan.batch.messageId) {
          if (await editInPlace(dm, orphan.batch.messageId, renderBatch(orphan.batch, detail))) {
            alertDms.inc({ action: 'edited', status: 'success' });
            res.json({ ok: true, action: 'edited', monitor, messageId: orphan.batch.messageId });
            return;
          }
        }
        const embed = orphan
          ? renderBatch(orphan.batch, detail)
          : new EmbedBuilder().setColor(COLOR_UP).setTitle(`🟢 UP — ${monitor}`).setTimestamp(new Date());
        if (!orphan && detail) embed.setDescription(`\`\`\`${detail.slice(0, 900)}\`\`\``);
        await deliver(embed, orphan?.batch.id);
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
