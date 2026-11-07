/**
 * Starts the scheduled reports when REPORTS_MODE asks for them (PET-701), and holds the one
 * instance /report and /health read.
 */
import { MessageFlags, type Client, type DMChannel } from 'discord.js';
import { GitHubApp } from '../desk/github.js';
import { logger } from '../utils/index.js';
import { PlaneClient } from './plane.js';
import { ReportRunner, chunk, type ReportsStatus, type Sender } from './runner.js';
import { AccessVerifier } from '../lab/access.js';
import { createDashboardApp, listenDashboard } from './dashboard.js';
import { loadReportSettings, type ReportSettings, type ReportsEnv, type ReportsState } from './settings.js';
import { loadWeeklySettings, type WeeklyEnv, type WeeklyState } from './weeklySettings.js';
import { ReportHub } from './hub.js';
import { CYCLE_KIND, cycleRecord } from './hubCycle.js';
import { CVE_KIND, cveRecord, shouldReplace } from './hubCve.js';
import { ollamaSummarizer, WeekStore, WeeklyRunner } from './weekly.js';

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
  if (state.state !== 'ready' && ((env as WeeklyEnv).WEEKLY_REPORT_DIR ?? '').trim()) {
    // The weekly report reads GitHub through these settings, so it cannot start without them.
    weekly = { state: 'misconfigured', reason: `WEEKLY_REPORT_DIR is set but the scheduled reports are ${state.state === 'off' ? 'off (REPORTS_MODE is empty)' : 'misconfigured'}` };
  }
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
    onMorning: (snap, date) => {
      const rec = cycleRecord(snap, date);
      if (rec && hub) hub.save(CYCLE_KIND, rec);
    },
    onCve: (run, date, at) => {
      if (!hub) {
        logger.info('[Reports] The cve run was not kept for the dashboard because the dashboard is off');
        return;
      }
      const rec = cveRecord(run, date, at);
      if (shouldReplace(hub.get(CVE_KIND, rec.id), rec)) hub.save(CVE_KIND, rec);
    },
  });
  runner.start();
  void startWeekly(s, env as WeeklyEnv);
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

let weekly: WeeklyState = { state: 'off' };
let weeklyRunner: WeeklyRunner | null = null;
let hub: ReportHub | null = null;

/** Where the other report kinds save a record for the dashboard. Null until the dashboard is on. */
export function getHub(): ReportHub | null {
  return hub;
}

/** The Sunday PR report and its Access-gated dashboard (PET-868). Reads GitHub as the reports do. */
async function startWeekly(s: ReportSettings, env: WeeklyEnv): Promise<void> {
  weekly = loadWeeklySettings(env);
  if (weekly.state === 'off') return;
  if (weekly.state === 'misconfigured') {
    logger.error(`[Weekly] The weekly report is off because it is misconfigured: ${weekly.reason}`);
    return;
  }
  const w = weekly.settings;
  try {
    const store = new WeekStore(w.dir);
    hub = new ReportHub(w.dir);
    const gh = new GitHubApp({ appId: s.appId, installationId: s.installationId, privateKeyPem: s.privateKeyPem, org: s.org });
    weeklyRunner = new WeeklyRunner({ gh, org: s.org, repos: s.repos, store, summarize: ollamaSummarizer(w.ollamaUrl), log: logger });
    const verifier = new AccessVerifier({ teamDomain: w.teamDomain, aud: w.aud, emails: w.emails });
    await listenDashboard(
      createDashboardApp({ store, hub, verify: (jwt) => verifier.verify(jwt), runner: weeklyRunner, log: (m) => logger.warn(`[Weekly] ${m}`) }),
      w.host,
      w.port,
    );
    weeklyRunner.start();
    logger.info(`[Weekly] Dashboard on ${w.host}:${w.port}, reports in ${w.dir}`);
  } catch (err) {
    weekly = { state: 'misconfigured', reason: String(err).slice(0, 200) };
    logger.error(`[Weekly] The weekly report did not start: ${String(err)}`);
  }
}

/** For /health. Running names the last attempt, so "never ran" and "ran and failed" differ. */
export function weeklyHealth(): { state: string; reason?: string; last?: unknown; lastFailure?: unknown } {
  if (weekly.state === 'misconfigured') return { state: 'misconfigured', reason: weekly.reason };
  if (weekly.state === 'off') return { state: 'off' };
  return { state: weeklyRunner ? 'running' : 'starting', last: weeklyRunner?.last ?? null, lastFailure: weeklyRunner?.lastFailure ?? null };
}
