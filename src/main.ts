/**
 * Pete Bot — a Discord surface for the homelab, and nothing more.
 *
 * Two jobs. POST /v1/alert takes an Uptime Kuma webhook and puts it in the owner's DM,
 * editing the original message on recovery. /update (PET-395) starts a media update
 * through GitHub Actions; the run holds the privileges, and this process holds a token
 * that can start that one workflow. /status reports what it is holding.
 *
 * It asks mtrace nothing. /ask and plain-DM questions went in PET-518, when Bobbert took
 * over asking mtrace with its own token. The Mission Control, ArgoCD and Kubernetes
 * clients this started as are gone with the cluster they queried.
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

// No privileged intent and no partials. The app reads no messages since PET-518: slash
// commands arrive as interactions, and alert DMs go out over REST. MessageContent and
// Partials.Channel existed only for plain-DM questions. Requesting MessageContent again
// makes login fail outright if the Developer Portal has it off.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
});

client.once('clientReady', async () => {
  logger.info(`Pete Bot v${VERSION} logged in as ${client.user?.tag}`);
  discordBotUp.set(1);

  setInterval(() => {
    discordWebsocketLatency.set(client.ws.ping / 1000);
  }, 30_000);

  await registerCommands();

  logger.info(`Pete Bot v${VERSION} ready — /status, /update, and /v1/alert`);
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
