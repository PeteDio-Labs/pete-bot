/**
 * Settings for the scheduled reports, checked once at startup (PET-701).
 *
 * THREE STATES. `off` (REPORTS_MODE empty) sends nothing. `misconfigured` sends nothing and
 * /health says why. `ready` runs the schedule.
 *
 * ⚠ A BAD SETTING DISABLES THE REPORTS, NOT THE BOT. Throwing at startup would also stop
 * Uptime Kuma's alerts, which is the job this process exists for. The desk follows
 * the same rule.
 *
 * The reports read GitHub as the merge desk's App (DESK_APP_*), so they work in any desk
 * mode. The App's key is read here and never logged.
 */
import { readFileSync } from 'node:fs';
import { REPO_NAME } from '../desk/config.js';

export const REPORT_NAMES = ['morning', 'audit', 'sweep', 'cve'] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

export interface PlaneSettings {
  baseUrl: string;
  workspace: string;
  projectId: string;
  apiKey: string;
}

export interface ReportSettings {
  org: string;
  repos: string[];
  appId: string;
  installationId: string;
  privateKeyPem: string;
  /** null when PLANE_API_KEY is empty. The reports then say Plane was not read. */
  plane: PlaneSettings | null;
  enabled: ReadonlySet<ReportName>;
  /** An open PR with no update for this many days is stale. */
  staleDays: number;
  statePath: string;
  /** A read-only checkout of the vault, for the audit's `verified:` dates. Empty skips them. */
  vaultPath: string;
  /** The inventory snapshot the CVE check reads (PET-770). Empty means `cve` cannot run. */
  cveSnapshotPath: string;
  /** File a PET item for each exploited or high-severity finding with a fix (Pedro, 2026-10-27). */
  cveFileItems: boolean;
}

export type ReportsState =
  | { state: 'off' }
  | { state: 'misconfigured'; reason: string }
  | { state: 'ready'; settings: ReportSettings };

export interface ReportsEnv {
  REPORTS_MODE?: string;
  REPORTS_ENABLED?: string;
  REPORT_STALE_DAYS?: string;
  REPORT_STATE_PATH?: string;
  REPORT_VAULT_PATH?: string;
  CVE_SNAPSHOT_PATH?: string;
  CVE_FILE_ITEMS?: string;
  REPORT_REPOS?: string;
  DESK_ORG?: string;
  DESK_APP_ID?: string;
  DESK_INSTALLATION_ID?: string;
  DESK_APP_KEY_PATH?: string;
  PLANE_BASE_URL?: string;
  PLANE_WORKSPACE?: string;
  PLANE_PROJECT_ID?: string;
  PLANE_API_KEY?: string;
}

const NUMERIC_ID = /^[1-9][0-9]{0,15}$/;

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadReportSettings(
  env: ReportsEnv,
  readKey: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): ReportsState {
  const mode = (env.REPORTS_MODE ?? '').trim();
  if (mode === '' || mode === 'off') return { state: 'off' };
  const bad = (reason: string): ReportsState => ({ state: 'misconfigured', reason });
  if (mode !== 'on') return bad(`REPORTS_MODE must be off or on, not "${mode}"`);

  const repos = list(env.REPORT_REPOS);
  if (repos.length === 0) return bad('REPORT_REPOS is empty');
  const badRepo = repos.find((r) => !REPO_NAME.test(r));
  if (badRepo) return bad(`REPORT_REPOS holds "${badRepo}", which is not a plain repository name`);

  const enabledNames = list(env.REPORTS_ENABLED);
  // `cve` joins the default set only when its snapshot path is set, so a host that never
  // configured it keeps the reports it had (PET-770).
  const names = enabledNames.length ? enabledNames : REPORT_NAMES.filter((n) => n !== 'cve' || (env.CVE_SNAPSHOT_PATH ?? '').trim() !== '');
  const unknown = names.find((n) => !(REPORT_NAMES as readonly string[]).includes(n));
  if (unknown) return bad(`REPORTS_ENABLED holds "${unknown}", which is not one of ${REPORT_NAMES.join(', ')}`);

  const appId = (env.DESK_APP_ID ?? '').trim();
  const installationId = (env.DESK_INSTALLATION_ID ?? '').trim();
  if (!NUMERIC_ID.test(appId)) return bad('DESK_APP_ID is missing or not numeric, so GitHub cannot be read');
  if (!NUMERIC_ID.test(installationId)) return bad('DESK_INSTALLATION_ID is missing or not numeric');
  const keyPath = (env.DESK_APP_KEY_PATH ?? '').trim();
  if (!keyPath) return bad('DESK_APP_KEY_PATH is empty');
  let privateKeyPem: string;
  try {
    privateKeyPem = readKey(keyPath);
  } catch (err) {
    return bad(`DESK_APP_KEY_PATH cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(privateKeyPem)) return bad('DESK_APP_KEY_PATH does not hold a PEM private key');

  const statePath = (env.REPORT_STATE_PATH ?? '').trim();
  if (!statePath) return bad('REPORT_STATE_PATH is empty, so a restart would send a report twice or lose it');

  const staleRaw = (env.REPORT_STALE_DAYS ?? '').trim();
  const staleDays = staleRaw === '' ? 3 : Number(staleRaw);
  if (!Number.isInteger(staleDays) || staleDays < 1) return bad(`REPORT_STALE_DAYS must be an integer of at least 1, not "${staleRaw}"`);

  if (names.includes('cve') && !(env.CVE_SNAPSHOT_PATH ?? '').trim()) return bad('CVE_SNAPSHOT_PATH is empty, so the cve report has nothing to read');

  const fileItems = (env.CVE_FILE_ITEMS ?? '').trim().toLowerCase();
  if (!['', 'on', 'off'].includes(fileItems)) return bad(`CVE_FILE_ITEMS must be on or off, not "${env.CVE_FILE_ITEMS}"`);

  const apiKey = (env.PLANE_API_KEY ?? '').trim();
  let plane: PlaneSettings | null = null;
  if (apiKey) {
    const baseUrl = (env.PLANE_BASE_URL ?? '').trim().replace(/\/+$/, '') || 'http://192.168.50.235:8080';
    const workspace = (env.PLANE_WORKSPACE ?? '').trim() || 'petedio';
    const projectId = (env.PLANE_PROJECT_ID ?? '').trim() || '2b962587-cfc8-404d-bbfc-d57c3a60e07f';
    if (!/^https?:\/\//.test(baseUrl)) return bad(`PLANE_BASE_URL must start with http:// or https://, not "${baseUrl}"`);
    plane = { baseUrl, workspace, projectId, apiKey };
  }

  return {
    state: 'ready',
    settings: {
      org: (env.DESK_ORG ?? '').trim() || 'PeteDio-Labs',
      repos,
      appId,
      installationId,
      privateKeyPem,
      plane,
      enabled: new Set(names as ReportName[]),
      staleDays,
      statePath,
      vaultPath: (env.REPORT_VAULT_PATH ?? '').trim(),
      cveSnapshotPath: (env.CVE_SNAPSHOT_PATH ?? '').trim(),
      cveFileItems: fileItems === 'on',
    },
  };
}
