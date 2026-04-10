/**
 * Pete Bot — Discord notification relay.
 *
 * Connects to MC Backend's SSE stream and DMs the owner on critical/warning
 * infrastructure events and agent completions. No AI, no tools, no slash
 * command execution — Mission Control is the brain, agents do the work.
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from './config.js';
import { registerCommands } from './commands/registerCommands.js';
import { createInteractionHandler } from './events/interactionCreate.js';
import { startMetricsServer } from './metrics/server.js';
import { discordBotUp, discordWebsocketLatency } from './metrics/index.js';
import { logger } from './utils/index.js';
import { startEventStream } from './listeners/eventStream.js';
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

  if (config.eventStream.enabled) {
    startEventStream(client, config.missionControl.url, config.eventStream.ownerUserId, {
      dedupWindowMs: config.eventStream.dedupWindowMs,
    });
  } else {
    logger.debug('[EventStream] Disabled');
  }

  logger.info(`Pete Bot v${VERSION} ready — notification relay only`);
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

  await client.login(config.discord.token);
}

export default start;
