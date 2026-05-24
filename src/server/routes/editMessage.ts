/**
 * POST /v1/edit-message (PB.6).
 *
 * MC calls this on plan state transitions so Discord stays in sync:
 *   - Approved by X → strip buttons + append "Approved by X"
 *   - In progress → keep buttons disabled, append "Running…"
 *   - Succeeded / failed / expired → strip buttons + append outcome
 *
 * Looks up the originally-posted (channelId, messageId) from messageCache.
 * If the cache lost the entry (Pete Bot restart), returns 404 — MC can choose
 * to re-notify or skip.
 *
 * Auth: HMAC verified by middleware before this handler runs.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Client, TextChannel } from 'discord.js';
import { logger } from '../../utils/index.js';
import { lookupMessage, forgetMessage } from '../messageCache.js';

// ─── Body schema ───────────────────────────────────────────────────────

const EditBodySchema = z.object({
  planId: z.string().regex(/^pl_[a-zA-Z0-9_-]{4,64}$/),
  newStatus: z.string().min(1).max(32),
  stripButtons: z.boolean(),
  appendText: z.string().max(500).optional(),
});

export function createEditMessageHandler(client: Client) {
  return async function editMessageHandler(req: Request, res: Response): Promise<void> {
    const parsed = EditBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', details: parsed.error.issues });
      return;
    }
    const { planId, newStatus, stripButtons, appendText } = parsed.data;

    const cached = lookupMessage(planId);
    if (!cached) {
      res.status(404).json({ error: 'message_not_cached', planId, hint: 'pete-bot may have restarted; re-notify to recover' });
      return;
    }

    let channel: TextChannel;
    try {
      const fetched = await client.channels.fetch(cached.channelId);
      if (!fetched || !fetched.isTextBased() || fetched.isDMBased()) {
        res.status(500).json({ error: 'channel_not_text', channelId: cached.channelId });
        return;
      }
      channel = fetched as TextChannel;
    } catch (err) {
      res.status(500).json({ error: 'channel_fetch_failed', detail: (err as Error).message });
      return;
    }

    try {
      const message = await channel.messages.fetch(cached.messageId);
      if (!message) {
        forgetMessage(planId);
        res.status(404).json({ error: 'message_not_found_in_channel', planId });
        return;
      }

      // Preserve the existing embed and append a status field.
      const embeds = message.embeds.map((e) => {
        const data = e.toJSON();
        const fields = (data.fields ?? []).slice();
        // Replace prior Status field if present, else append
        const idx = fields.findIndex((f) => f.name === 'Status');
        const statusField = { name: 'Status', value: newStatus, inline: true };
        if (idx >= 0) {
          fields[idx] = statusField;
        } else {
          fields.push(statusField);
        }
        if (appendText) {
          const idxNote = fields.findIndex((f) => f.name === 'Note');
          const noteField = { name: 'Note', value: appendText, inline: false };
          if (idxNote >= 0) fields[idxNote] = noteField;
          else fields.push(noteField);
        }
        return { ...data, fields };
      });

      await message.edit({
        embeds,
        components: stripButtons ? [] : undefined,
      });

      if (stripButtons) {
        // Terminal — drop from cache to free room
        forgetMessage(planId);
      }

      logger.info('Plan message edited', {
        planId,
        newStatus,
        stripButtons,
        channelId: channel.id,
        messageId: message.id,
      });

      res.json({ ok: true, planId, channelId: channel.id, messageId: message.id });
    } catch (err) {
      logger.error('Failed to edit Plan message', {
        planId,
        error: (err as Error).message,
      });
      res.status(500).json({ error: 'discord_edit_failed', detail: (err as Error).message });
    }
  };
}
