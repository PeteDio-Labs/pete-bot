/**
 * Starts the scheduled reports when REPORTS_MODE asks for them (PET-701), and holds the one
 * instance /report and /health read.
 */
import { MessageFlags, type Client, type DMChannel } from 'discord.js';
import { GitHubApp } from '../desk/github.js';
import { logger } from '../utils/index.js';
import { PlaneClient } from './plane.js';
import { ReportRunner, chunk, type ReportsStatus, type Sender } from './runner.js';
import { loadReportSettings, type ReportsEnv, type ReportsState } from './settings.js';

let runner: ReportRunner | null = null;
let state: ReportsState = { state: 'off' };

/** DMs the owner. Nothing in a report may ping anyone: PR titles are other people's text. */
export function discordSender(client: Client, ownerUserId: string): Sender {
  return {
    async send(text) {
      const user = await client.users.fetch(ownerUserId);
      const dm = (await user.createDM()) as DMChannel;
      for (const part of chunk(text)) await dm.send({ content: part, allowedMentions: { parse: [] }, flags: MessageFlags.SuppressEmbeds });
    },
  };
}

export function startReports(client: Client, ownerUserId: string, env: ReportsEnv = process.env as ReportsEnv): void {
  state = loadReportSettings(env);
  if (state.state === 'off') {
    logger.info('[Reports] The scheduled reports are off (REPORTS_MODE is empty)');
    return;
  }
  if (state.state === 'misconfigured') {
    logger.error(`[Reports] The scheduled reports are off because they are misconfigured: ${state.reason}`);
    return;
  }
  const s = state.settings;
  runner = new ReportRunner({
    settings: s,
    github: new GitHubApp({ appId: s.appId, installationId: s.installationId, privateKeyPem: s.privateKeyPem, org: s.org }),
    plane: s.plane ? new PlaneClient(s.plane) : null,
    sender: discordSender(client, ownerUserId),
    log: logger,
  });
  runner.start();
  logger.info(`[Reports] Scheduled ${[...s.enabled].join(', ')} for ${s.repos.join(', ')}${s.plane ? '' : ' (Plane key absent: Plane will be reported as not read)'}`);
}

export function getReports(): ReportRunner | null {
  return runner;
}

/** For /health. A running state names each report's last result, so "quiet" and "never ran" differ. */
export function reportsHealth(): { state: string; reason?: string } & Partial<ReportsStatus> {
  if (state.state === 'misconfigured') return { state: 'misconfigured', reason: state.reason };
  if (!runner) return { state: state.state === 'ready' ? 'starting' : 'off' };
  return { state: 'running', ...runner.status() };
}
