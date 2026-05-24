/**
 * MC Backend HTTP client (PB.6 — click forwarder side; covers RETRO.15 (d)).
 *
 * One signed POST: /api/v1/discord/callback — invoked from the InteractionCreate
 * button handler after a user clicks a Plan action button. Mirrors the inbound
 * verifier on MC side (services/notifications/peteBotClient.ts) — same shared
 * secret PETE_BOT_HMAC_SECRET sealed via SEC.3.
 *
 * Sender contract (matches what MC's verifyHmac() expects):
 *   x-pete-bot-signature: sha256=<hex>
 *   x-pete-bot-timestamp: <ms epoch>
 *   body signed: `${timestamp}.${rawBody}` where rawBody is the literal JSON sent
 *
 * Returns the parsed MC response — caller handles status code semantics
 * (200 = approved, 403 = unauthorized, 409 = duplicate, 410 = closed, etc.)
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/index.js';

const REQUEST_TIMEOUT_MS = 8000;

export interface CallbackInput {
  planId: string;
  actionId: string;
  discordUserId: string;
  channelId?: string;
  messageId?: string;
}

export interface CallbackResponse {
  status: number;
  body: unknown;
  /** Quick boolean — convenience for happy-path branching. */
  ok: boolean;
}

export async function postDiscordCallback(input: CallbackInput): Promise<CallbackResponse> {
  const secret = config.httpServer.hmacSecret;
  if (!secret) {
    logger.error('postDiscordCallback: PETE_BOT_HMAC_SECRET unset — cannot sign');
    return { status: 0, body: { error: 'hmac_secret_unset' }, ok: false };
  }

  const url = `${config.missionControl.url.replace(/\/$/, '')}/api/v1/discord/callback`;
  const rawBody = JSON.stringify({
    planId: input.planId,
    actionId: input.actionId,
    discordUserId: input.discordUserId,
    clickTs: new Date().toISOString(),
    channelId: input.channelId,
    messageId: input.messageId,
  });
  const timestamp = Date.now().toString();
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pete-bot-signature': `sha256=${signature}`,
        'x-pete-bot-timestamp': timestamp,
      },
      body: rawBody,
      signal: controller.signal,
    });

    let body: unknown;
    const ct = resp.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      try { body = await resp.json(); } catch { body = null; }
    } else {
      try { body = await resp.text(); } catch { body = null; }
    }

    return { status: resp.status, body, ok: resp.ok };
  } catch (err) {
    const msg = (err as Error).message;
    if ((err as Error).name === 'AbortError') {
      logger.warn('postDiscordCallback: timed out');
      return { status: 0, body: { error: 'timeout' }, ok: false };
    }
    logger.error('postDiscordCallback: request failed', { error: msg });
    return { status: 0, body: { error: msg }, ok: false };
  } finally {
    clearTimeout(timeout);
  }
}
