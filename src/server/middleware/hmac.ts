/**
 * HMAC verify middleware (PB.6).
 *
 * Mirrors the MC Backend inbound verifier in
 * apps/mission-control/mission-control-backend/src/api/routes/discord.ts
 * but applied to MC → Pete Bot calls. Same shared secret
 * (PETE_BOT_HMAC_SECRET sealed via SEC.3).
 *
 * Sender signs `${timestamp}.${rawBody}` with HMAC-SHA256 and sends:
 *   x-pete-bot-signature: sha256=<hex>
 *   x-pete-bot-timestamp: <ms epoch>
 *
 * Replay protection: timestamps older than `replayWindowMs` are rejected.
 * Constant-time compare prevents timing attacks.
 *
 * Requires the `rawBody` middleware to have run first (sets req.rawBody).
 */

import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/index.js';

export interface HmacOptions {
  secret: string;
  /** Reject timestamps older than this many ms. */
  replayWindowMs: number;
}

export function hmacVerify(opts: HmacOptions) {
  return function hmacMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!opts.secret) {
      logger.error('hmacVerify: PETE_BOT_HMAC_SECRET unset — rejecting');
      res.status(500).json({ error: 'server_misconfigured', reason: 'hmac_secret_unset' });
      return;
    }

    const sigHeader = req.header('x-pete-bot-signature');
    const tsHeader = req.header('x-pete-bot-timestamp');
    if (!sigHeader || !tsHeader) {
      res.status(401).json({ error: 'unauthorized', reason: 'missing_signature_or_timestamp' });
      return;
    }

    const ts = parseInt(tsHeader, 10);
    if (!Number.isFinite(ts)) {
      res.status(401).json({ error: 'unauthorized', reason: 'invalid_timestamp' });
      return;
    }
    if (Math.abs(Date.now() - ts) > opts.replayWindowMs) {
      res.status(401).json({ error: 'unauthorized', reason: 'timestamp_out_of_window' });
      return;
    }

    const rawBody = (req as Request & { rawBody?: string }).rawBody;
    if (rawBody === undefined) {
      logger.error('hmacVerify: rawBody missing — express.json verify middleware not wired');
      res.status(500).json({ error: 'server_misconfigured', reason: 'rawbody_missing' });
      return;
    }

    const expected = crypto
      .createHmac('sha256', opts.secret)
      .update(`${tsHeader}.${rawBody}`)
      .digest('hex');
    const expectedHeader = `sha256=${expected}`;

    if (sigHeader.length !== expectedHeader.length) {
      logger.warn('hmacVerify: signature length mismatch', { ip: req.ip });
      res.status(401).json({ error: 'unauthorized', reason: 'bad_signature' });
      return;
    }

    let ok: boolean;
    try {
      ok = crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expectedHeader));
    } catch {
      ok = false;
    }
    if (!ok) {
      logger.warn('hmacVerify: bad signature', { ip: req.ip });
      res.status(401).json({ error: 'unauthorized', reason: 'bad_signature' });
      return;
    }

    next();
  };
}
