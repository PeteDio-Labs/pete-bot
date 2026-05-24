/**
 * Pete Bot HTTP server (PB.6).
 *
 * Express app on port 3015 (configurable). Routes:
 *   GET  /health           — liveness + readiness probe (no auth)
 *   POST /v1/notify        — render + post a fresh Plan (HMAC verified)
 *   POST /v1/edit-message  — edit a previously-posted Plan message (HMAC verified)
 *
 * Kept separate from the metrics server (port 9090) so:
 *   - Prometheus can scrape /metrics on a port unaffected by app traffic
 *   - K8s NetworkPolicy can scope MC→Pete Bot traffic to 3015 only
 *   - Outage in app server doesn't affect metrics scraping
 *
 * Auth: every /v1/* route runs through hmacVerify with PETE_BOT_HMAC_SECRET.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';
import type { Client } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/index.js';
import { hmacVerify } from './middleware/hmac.js';
import { createNotifyHandler } from './routes/notify.js';
import { createEditMessageHandler } from './routes/editMessage.js';
import { cacheSize } from './messageCache.js';

let server: Server | null = null;

export async function startHttpServer(client: Client): Promise<Server> {
  if (server) {
    throw new Error('HTTP server is already running');
  }

  const app = express();

  // rawBody capture so HMAC verify works against the literal request bytes.
  // Mirrors the pattern in MC backend's app.ts (RETRO.13).
  app.use(
    express.json({
      limit: '512kb',
      verify: (req: Request, _res: Response, buf: Buffer) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

  // ── Health (public, no auth) ─────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'pete-bot-http',
      uptimeSeconds: process.uptime(),
      messageCacheSize: cacheSize(),
      timestamp: new Date().toISOString(),
    });
  });

  // ── HMAC-protected app routes ────────────────────────────────────
  const hmac = hmacVerify({
    secret: config.httpServer.hmacSecret,
    replayWindowMs: config.httpServer.replayWindowMs,
  });

  app.post('/v1/notify', hmac, createNotifyHandler(client));
  app.post('/v1/edit-message', hmac, createEditMessageHandler(client));

  // ── 404 ─────────────────────────────────────────────────────────
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // ── Error handler ───────────────────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Pete Bot HTTP unhandled error', { error: err.message });
    res.status(500).json({ error: 'internal_error' });
  });

  return new Promise((resolve, reject) => {
    const httpServer = app.listen(config.httpServer.port, () => {
      server = httpServer;
      resolve(httpServer);
    });
    httpServer.on('error', reject);
  });
}

export async function stopHttpServer(): Promise<void> {
  if (!server) return;
  return new Promise((resolve, reject) => {
    server!.close((err) => {
      if (err) {
        reject(err);
      } else {
        server = null;
        resolve();
      }
    });
  });
}
