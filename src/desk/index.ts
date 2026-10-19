/**
 * Starts the merge desk when DESK_MODE asks for it (PET-645), and holds the one instance
 * the Discord button handler and /health read.
 */
import type { Client } from 'discord.js';
import { loadDeskSettings, type DeskState, type DeskEnv } from './config.js';
import { CodexQueue } from './codex.js';
import { MergeDesk, type DeskStatus } from './desk.js';
import { discordNotifier } from './discord.js';
import { GitHubApp } from './github.js';
import { DeskStore } from './store.js';
import { logger } from '../utils/index.js';

let desk: MergeDesk | null = null;
let deskState: DeskState = { state: 'off' };

export function startDesk(client: Client, ownerUserId: string, env: DeskEnv = process.env as DeskEnv): void {
  deskState = loadDeskSettings(env);
  if (deskState.state === 'off') {
    logger.info('[Desk] The merge desk is off (DESK_MODE is empty)');
    return;
  }
  if (deskState.state === 'misconfigured') {
    logger.error(`[Desk] The merge desk is off because it is misconfigured: ${deskState.reason}`);
    return;
  }
  const s = deskState.settings;
  let store: DeskStore;
  try {
    store = new DeskStore(s.statePath);
  } catch (err) {
    // Without its memory the desk would queue and DM twice, so it stays off and says why.
    deskState = { state: 'misconfigured', reason: `DESK_STATE_PATH ${s.statePath} cannot be opened: ${String(err)}` };
    logger.error(`[Desk] The merge desk is off because it is misconfigured: ${deskState.reason}`);
    return;
  }
  desk = new MergeDesk({
    settings: s,
    github: new GitHubApp({ appId: s.appId, installationId: s.installationId, privateKeyPem: s.privateKeyPem, org: s.org }),
    codex: new CodexQueue(s.codex),
    store,
    notifier: discordNotifier(client, ownerUserId),
    log: logger,
  });
  desk.start();
  logger.info(`[Desk] The merge desk is ${s.mode} for ${s.repos.join(', ')}`);
}

export function getDesk(): MergeDesk | null {
  return desk;
}

/** For /health: the state, and once running, what the last poll read. */
export function deskHealth(): { state: string; reason?: string } & Partial<DeskStatus> {
  if (deskState.state === 'misconfigured') return { state: 'misconfigured', reason: deskState.reason };
  if (!desk) return { state: deskState.state === 'ready' ? 'starting' : 'off' };
  return { state: 'running', ...desk.status() };
}
