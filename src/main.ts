/**
 * Pete Bot — a Discord surface for the homelab, and nothing more.
 *
 * Two jobs. /ask forwards a question to mtrace on media-dash-237 and renders the
 * answer; mtrace owns the tool set and the routing, including the keyword fallback
 * that answers when Ollama is down. POST /v1/alert takes an Uptime Kuma webhook and
 * puts it in the owner's DM, editing the original message on recovery.
 *
 * It holds no tools of its own. The Mission Control, ArgoCD and Kubernetes clients
 * this started as are gone with the cluster they queried.
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { registerCommands } from './commands/registerCommands.js';
import { createInteractionHandler } from './events/interactionCreate.js';
import { startMetricsServer } from './metrics/server.js';
import { startHttpServer } from './server/index.js';
import { discordBotUp, discordWebsocketLatency } from './metrics/index.js';
import { logger } from './utils/index.js';
import packageJson from '../package.json' with { type: 'json' };

const VERSION = packageJson.version;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('clientReady', async () => {
  logger.info(`Pete Bot v${VERSION} logged in as ${client.user?.tag}`);
  discordBotUp.set(1);

  setInterval(() => {
    discordWebsocketLatency.set(client.ws.ping / 1000);
  }, 30_000);

  await registerCommands();

  logger.info(`Pete Bot v${VERSION} ready — /ask and /v1/alert`);
});

client.on('disconnect', () => {
  logger.warn('Discord bot disconnected');
  discordBotUp.set(0);
});

client.on('error', (error) => {
  logger.error('Discord bot error:', error);
  discordBotUp.set(0);
});

client.on('interactionCreate', createInteractionHandler());

export async function start(): Promise<void> {
  logger.info(`Starting Pete Bot v${VERSION}`);

  if (config.metrics.enabled) {
    try {
      await startMetricsServer(config.metrics.port);
      logger.info(`[Metrics] Listening on port ${config.metrics.port}`);
    } catch (error) {
      logger.error('[Metrics] Failed to start server:', error);
    }
  }

  // HTTP server for inbound alerts (/v1/alert) and the notify/edit pair.
  // Started BEFORE Discord login so the Client is ready (.channels.fetch works
  // only after login — but the server only accepts traffic once health passes,
  // and the routes themselves await client.channels.fetch which queues until
  // ready. Express on a separate port doesn't depend on Discord readiness for
  // /health, so the K8s readiness probe can pass independently.
  if (config.httpServer.enabled) {
    try {
      await startHttpServer(client);
      logger.info(`[HTTP] Listening on port ${config.httpServer.port}`);
    } catch (error) {
      logger.error('[HTTP] Failed to start server:', error);
    }
  }

  await client.login(config.discord.token);
}

export default start;
