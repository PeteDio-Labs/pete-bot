/**
 * Pete Bot HTTP server (PB.6).
 *
 * Express app on port 3015 (configurable). Routes:
 *   GET  /health           — liveness + readiness probe (no auth)
 *   POST /v1/alert         — Uptime Kuma webhook → the owner's DM (bearer token)
 *   POST /v1/notify        — free-text message → the owner's DM (bearer token)
 *   POST /v1/llm/v1/messages — the Anthropic API gateway (per-caller bearer, PET-617)
 *
 * Kept separate from the metrics server (port 9090) so Prometheus scrapes a port that
 * app traffic cannot affect, and so a NetworkPolicy can scope inbound alerts to 3015.
 *
 * Auth: /v1/alert checks a bearer token. HMAC is gone with the Mission Control
 * routes it protected — Kuma cannot sign a body, so it could never have used it.
 *
 * ⚠ createApp IS SEPARATE FROM startHttpServer ON PURPOSE. Binding a port inside the
 * only constructor makes every route test race every other test file for it, which is
 * part of why this server shipped with no tests at all (PET-384).
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';
import type { Client } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../utils/index.js';
import { createAlertHandler } from './routes/alert.js';
import { createNotifyHandler } from './routes/notify.js';
import { size as openIncidents } from './alertStore.js';
import { deskHealth } from '../desk/index.js';
import { parseGatewaySettings } from '../gateway/config.js';
import { createGateway, gatewayErrorHandler, LLM_ROUTES, type Gateway } from '../gateway/route.js';

let server: Server | null = null;
let gateway: Gateway | null = null;

/** Built from config once per process, so the ledger opens once. */
function defaultGateway(): Gateway {
  gateway ??= createGateway(
    parseGatewaySettings({
      apiKey: config.llm.apiKey,
      callersJson: config.llm.callersJson,
      ledgerPath: config.llm.ledgerPath,
      otherTokens: [config.httpServer.alertToken, config.httpServer.notifyToken],
    }),
  );
  return gateway;
}

export interface AppOptions {
  /** Tests inject a gateway with a fake fetch and an in-memory ledger. */
  gateway?: Gateway;
}

export function createApp(client: Client, options: AppOptions = {}): Express {
  const app = express();
  const llm = options.gateway ?? defaultGateway();

  // ⚠ REGISTERED BEFORE THE GLOBAL PARSER ON PURPOSE. An agent's request carries its
  // whole conversation and every tool result, which passes 512kb long before it passes
  // the model's context. express.json skips a body already parsed, so this limit wins
  // on the gateway's paths and 512kb holds everywhere else. The guard runs first, so a
  // caller with no valid token is refused before 8mb is read.
  app.use('/v1/llm', (req, res, next) => llm.guard(req, res, next), express.json({ limit: '8mb' }));

  app.use(
    express.json({
      limit: '512kb',
      verify: (req: Request, _res: Response, buf: Buffer) => {
        (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

  // ── Health (public, no auth, carries nothing sensitive) ──────────
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'pete-bot-http',
      uptimeSeconds: process.uptime(),
      alertBatches: openIncidents(),
      // off, misconfigured or on. Off is normal until a key is seeded. Misconfigured
      // means a guard setting is wrong, and the deploy check should fail on it.
      llm: llm.state,
      // off, misconfigured, starting or running (PET-645). Running carries what the last
      // poll read, so "nothing to merge" and "read nothing" look different.
      desk: deskHealth(),
      timestamp: new Date().toISOString(),
    });
  });

  // ── Alert intake, bearer-gated rather than HMAC ──────────────────
  // Uptime Kuma's generic webhook cannot sign a body, so hmacVerify cannot gate the
  // route it posts to. The handler checks a bearer token itself. Keep it off the
  // `hmac` chain deliberately; do not "fix" this by adding hmac and wondering why
  // Kuma 401s.
  app.post('/v1/alert', createAlertHandler(client));

  // ── Free-text notify, same bearer as /v1/alert (PET-579) ─────────
  app.post('/v1/notify', createNotifyHandler(client));

  // ── Anthropic API gateway, one bearer and one cap per caller (PET-617) ──
  app.post(LLM_ROUTES, (req, res, next) => {
    llm.handle(req, res).catch(next);
  });
  app.use('/v1/llm', gatewayErrorHandler);

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Pete Bot HTTP unhandled error', { error: err.message });
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

export async function startHttpServer(client: Client): Promise<Server> {
  if (server) {
    throw new Error('HTTP server is already running');
  }

  const app = createApp(client);

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
