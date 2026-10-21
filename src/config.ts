// Configuration module
import 'dotenv/config';
import { parseWindows, type MaintenanceWindow } from './server/decider.js';

interface Config {
  discord: {
    token: string;
    clientId: string;
    /**
     * The only user this app answers. For a user-installed app Discord reports the
     * installer as `authorizing_integration_owners`, and every interaction is checked
     * against this id — an app installed by anyone else answers nobody.
     */
    ownerUserId: string;
  };
  metrics: {
    enabled: boolean;
    port: number;
  };
  /** PET-384 — how alerts are grouped, and where that grouping is remembered. */
  alerts: {
    /**
     * Two monitors failing inside this window share one DM. A node reboot takes eight
     * services down in seconds and should read as one incident.
     *
     * ⚠ IT IS BOUNDED ON PURPOSE. Editing an existing message raises no Discord
     * notification, so an unbounded window would fold a brand-new outage silently into
     * an old message — the exact failure this alerting exists to end. Set 0 to disable
     * grouping entirely.
     */
    coalesceMs: number;
    /**
     * Where open incidents are remembered across a restart. Empty means memory only,
     * which costs edit-in-place: a restart between DOWN and UP orphans the DOWN message
     * and posts the recovery separately.
     */
    statePath: string;
    /**
     * PET-492 — windows in which a DOWN is held instead of sent. petedio-iac renders them
     * from the backup schedule. Empty turns the hold off. A malformed value throws at
     * start, so the deploy's health check fails instead of the hold silently turning off.
     */
    maintenanceWindows: MaintenanceWindow[];
    /** The deadline for a held DOWN until a monitor has enough recoveries on record. */
    maintenanceDeadlineMs: number;
    /** Recovery times per monitor, for the deadline. Empty keeps them in memory only. */
    baselinePath: string;
  };
  /**
   * /update (PET-395). pete-bot starts petedio-media-iac's media-updates.yml and reads
   * the run back; the run holds every privilege. This token can run workflows in that one
   * repo and nothing else. Empty leaves /update answering "not configured".
   */
  updates: {
    token: string;
    repo: string;
    workflow: string;
    /** How long a dispatched run may take to appear, and to finish. */
    findTimeoutMs: number;
    runTimeoutMs: number;
    pollMs: number;
  };
  /**
   * /lab (PET-669). pete-bot posts the question to lab-agent on 127.0.0.1 and relays the
   * answer. lab-agent runs the model loop and holds the read credentials; pete-bot gives it
   * none of its own. An empty token leaves /lab answering "not configured".
   */
  lab: {
    url: string;
    token: string;
    timeoutMs: number;
  };
  /** PB.6 — HTTP server for inbound alerts and the notify/edit-message pair. */
  httpServer: {
    enabled: boolean;
    port: number;
    /**
     * Bearer token for POST /v1/alert.
     *
     * ⚠ NOT HMAC, and that is forced rather than chosen. Uptime Kuma's generic
     * webhook cannot sign a body, so hmacVerify cannot gate the route it posts to.
     * A bearer in a header is the strongest thing the sender can actually produce.
     * The HMAC routes keep HMAC.
     */
    alertToken: string;
    /**
     * Bearer token for POST /v1/notify (PET-584). Separate from alertToken, so a session
     * that can DM the owner cannot also post a fake monitor alert. Empty refuses every
     * request.
     */
    notifyToken: string;
  };
  /**
   * The Anthropic API gateway (PET-617). src/gateway/config.ts checks these at startup.
   * An empty key leaves the gateway off and every other route unchanged.
   */
  llm: {
    apiKey: string;
    /** JSON: caller name to its bearer, monthly cap in dollars, and allowed models. */
    callersJson: string;
    /** The SQLite ledger the caps read. Required whenever the key is set. */
    ledgerPath: string;
  };
}

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (!value && defaultValue === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value ?? defaultValue ?? '';
}

/** A malformed value stops the process at start. NaN here would expire every hold at once. */
function positiveInt(name: string, defaultValue: string): number {
  const raw = getEnvVar(name, defaultValue);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number of milliseconds, got "${raw}"`);
  return value;
}

export const config: Config = {
  discord: {
    token: getEnvVar('DISCORD_TOKEN'),
    clientId: getEnvVar('DISCORD_CLIENT_ID'),
    ownerUserId: getEnvVar('OWNER_USER_ID'),
  },
  metrics: {
    enabled: getEnvVar('METRICS_ENABLED', 'true') === 'true',
    port: parseInt(getEnvVar('METRICS_PORT', '9090'), 10),
  },
  alerts: {
    coalesceMs: parseInt(getEnvVar('ALERT_COALESCE_MS', '60000'), 10),
    statePath: getEnvVar('ALERT_STATE_PATH', ''),
    maintenanceWindows: parseWindows(getEnvVar('ALERT_MAINTENANCE_WINDOWS', '')),
    // The longest nightly recovery on record is 100 s, so 5 minutes suppresses every ordinary night.
    maintenanceDeadlineMs: positiveInt('ALERT_MAINTENANCE_DEADLINE_MS', '300000'),
    baselinePath: getEnvVar('ALERT_BASELINE_PATH', ''),
  },
  updates: {
    token: getEnvVar('GITHUB_UPDATES_TOKEN', ''),
    repo: getEnvVar('UPDATES_REPO', 'PeteDio-Labs/petedio-media-iac'),
    workflow: getEnvVar('UPDATES_WORKFLOW', 'media-updates.yml'),
    // A runner picks a dispatch up within seconds when idle; 90s covers a busy queue.
    findTimeoutMs: parseInt(getEnvVar('UPDATES_FIND_TIMEOUT_MS', '90000'), 10),
    // The workflow itself times out at 30 minutes, so following it longer is pointless.
    runTimeoutMs: parseInt(getEnvVar('UPDATES_RUN_TIMEOUT_MS', '1800000'), 10),
    pollMs: parseInt(getEnvVar('UPDATES_POLL_MS', '10000'), 10),
  },
  lab: {
    url: getEnvVar('LAB_AGENT_URL', 'http://127.0.0.1:3016'),
    token: getEnvVar('LAB_ASK_TOKEN', ''),
    // Eight model turns with tool calls between them; past this the answer is not coming.
    timeoutMs: parseInt(getEnvVar('LAB_TIMEOUT_MS', '120000'), 10),
  },
  httpServer: {
    enabled: getEnvVar('HTTP_SERVER_ENABLED', 'true') === 'true',
    port: parseInt(getEnvVar('HTTP_SERVER_PORT', '3015'), 10),
    alertToken: getEnvVar('ALERT_BEARER_TOKEN', ''),
    notifyToken: getEnvVar('NOTIFY_BEARER_TOKEN', ''),
  },
  llm: {
    apiKey: getEnvVar('ANTHROPIC_API_KEY', ''),
    callersJson: getEnvVar('LLM_GATEWAY_CALLERS', ''),
    ledgerPath: getEnvVar('LLM_LEDGER_PATH', ''),
  },
};

export default config;
