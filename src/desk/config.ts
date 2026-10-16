/**
 * The merge desk's settings, checked once at startup (PET-645).
 *
 * FOUR STATES, AND ONLY ONE MERGES.
 *
 *   off            DESK_MODE is empty or `off`. The desk polls nothing.
 *   misconfigured  DESK_MODE asks for the desk, but a setting is missing or malformed.
 *                  The desk polls nothing, and /health says why.
 *   dry-run        Every step runs except the approval and the merge. Each merge the
 *                  desk would make arrives as a DM that says so.
 *   on             Every check below passed, and the desk merges.
 *
 * ⚠ A BAD SETTING DISABLES THE DESK, NOT THE BOT. Throwing at startup would also stop
 * Uptime Kuma's alerts, which is the job this process exists for. The gateway follows the
 * same rule (src/gateway/config.ts).
 */
import { readFileSync } from 'node:fs';

export type DeskMode = 'dry-run' | 'on';

export interface DeskSettings {
  mode: DeskMode;
  org: string;
  /** Repositories the desk watches, without the org. */
  repos: string[];
  /** GitHub logins whose PRs the desk may merge. Anyone else's PR is skipped. */
  authors: ReadonlySet<string>;
  appId: string;
  installationId: string;
  privateKeyPem: string;
  pollMs: number;
  statePath: string;
  /** Where the tier rules live: one file on the default branch of one repository. */
  classifierRepo: string;
  classifierPath: string;
  python: string;
  codex: {
    target: string;
    keyPath: string;
    knownHostsPath: string;
    timeoutMs: number;
  };
}

export type DeskState =
  | { state: 'off' }
  | { state: 'misconfigured'; reason: string }
  | { state: 'ready'; settings: DeskSettings };

export interface DeskEnv {
  DESK_MODE?: string;
  DESK_ORG?: string;
  DESK_REPOS?: string;
  DESK_AUTHORS?: string;
  DESK_APP_ID?: string;
  DESK_INSTALLATION_ID?: string;
  DESK_APP_KEY_PATH?: string;
  DESK_POLL_MS?: string;
  DESK_STATE_PATH?: string;
  DESK_CLASSIFIER_REPO?: string;
  DESK_CLASSIFIER_PATH?: string;
  DESK_PYTHON?: string;
  DESK_CODEX_SSH_TARGET?: string;
  DESK_CODEX_SSH_KEY?: string;
  DESK_CODEX_KNOWN_HOSTS?: string;
  DESK_CODEX_TIMEOUT_MS?: string;
}

/** The names codex-review-gate on codex-248 accepts. A wider name never reaches ssh. */
export const REPO_NAME = /^[a-z0-9-]+$/;
const LOGIN = /^[A-Za-z0-9-]+(\[bot\])?$/;
const NUMERIC_ID = /^[1-9][0-9]{0,15}$/;

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(value: string | undefined, fallback: number, min: number): number | string {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) return `must be an integer of at least ${min}, not "${value}"`;
  return n;
}

export function loadDeskSettings(
  env: DeskEnv,
  readKey: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): DeskState {
  const mode = (env.DESK_MODE ?? '').trim();
  if (mode === '' || mode === 'off') return { state: 'off' };
  const bad = (reason: string): DeskState => ({ state: 'misconfigured', reason });
  if (mode !== 'dry-run' && mode !== 'on') return bad(`DESK_MODE must be off, dry-run or on, not "${mode}"`);

  const repos = list(env.DESK_REPOS);
  if (repos.length === 0) return bad('DESK_REPOS is empty');
  const badRepo = repos.find((r) => !REPO_NAME.test(r));
  if (badRepo) return bad(`DESK_REPOS holds "${badRepo}", which is not a plain repository name`);

  const authors = list(env.DESK_AUTHORS);
  if (authors.length === 0) return bad('DESK_AUTHORS is empty, so no PR could ever merge');
  const badAuthor = authors.find((a) => !LOGIN.test(a));
  if (badAuthor) return bad(`DESK_AUTHORS holds "${badAuthor}", which is not a GitHub login`);

  const appId = (env.DESK_APP_ID ?? '').trim();
  const installationId = (env.DESK_INSTALLATION_ID ?? '').trim();
  if (!NUMERIC_ID.test(appId)) return bad('DESK_APP_ID is missing or not numeric');
  if (!NUMERIC_ID.test(installationId)) return bad('DESK_INSTALLATION_ID is missing or not numeric');

  const keyPath = (env.DESK_APP_KEY_PATH ?? '').trim();
  if (!keyPath) return bad('DESK_APP_KEY_PATH is empty');
  let privateKeyPem: string;
  try {
    privateKeyPem = readKey(keyPath);
  } catch (err) {
    return bad(`DESK_APP_KEY_PATH cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(privateKeyPem)) {
    return bad('DESK_APP_KEY_PATH does not hold a PEM private key');
  }

  const statePath = (env.DESK_STATE_PATH ?? '').trim();
  if (!statePath) return bad('DESK_STATE_PATH is empty, so the desk would forget what it queued on restart');

  const codexTarget = (env.DESK_CODEX_SSH_TARGET ?? '').trim();
  const codexKey = (env.DESK_CODEX_SSH_KEY ?? '').trim();
  const knownHosts = (env.DESK_CODEX_KNOWN_HOSTS ?? '').trim();
  if (!/^[a-z_][a-z0-9_-]*@[A-Za-z0-9.-]+$/.test(codexTarget)) {
    return bad('DESK_CODEX_SSH_TARGET must be user@host');
  }
  if (!codexKey) return bad('DESK_CODEX_SSH_KEY is empty');
  if (!knownHosts) return bad('DESK_CODEX_KNOWN_HOSTS is empty, so ssh could not pin codex-248');

  // Polling faster than once a minute buys nothing: a Codex review takes minutes.
  const pollMs = int(env.DESK_POLL_MS, 180_000, 60_000);
  if (typeof pollMs === 'string') return bad(`DESK_POLL_MS ${pollMs}`);
  // codex-review waits up to an hour for its lock, then reviews.
  const timeoutMs = int(env.DESK_CODEX_TIMEOUT_MS, 90 * 60_000, 60_000);
  if (typeof timeoutMs === 'string') return bad(`DESK_CODEX_TIMEOUT_MS ${timeoutMs}`);

  return {
    state: 'ready',
    settings: {
      mode,
      org: (env.DESK_ORG ?? '').trim() || 'PeteDio-Labs',
      repos,
      authors: new Set(authors.map((a) => a.toLowerCase())),
      appId,
      installationId,
      privateKeyPem,
      pollMs,
      statePath,
      classifierRepo: (env.DESK_CLASSIFIER_REPO ?? '').trim() || 'petedio-iac',
      classifierPath: (env.DESK_CLASSIFIER_PATH ?? '').trim() || 'scripts/pr-blast-radius.py',
      python: (env.DESK_PYTHON ?? '').trim() || 'python3',
      codex: { target: codexTarget, keyPath: codexKey, knownHostsPath: knownHosts, timeoutMs },
    },
  };
}
