// Configuration module
import 'dotenv/config';

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
  /** mtrace on media-dash-237 answers the questions. This app only asks and renders. */
  mtrace: {
    url: string;
    token: string;
    timeoutMs: number;
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
  };
}

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (!value && defaultValue === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value ?? defaultValue ?? '';
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
  mtrace: {
    // Loopback: this app runs on media-dash-237 beside mtrace, which binds
    // 127.0.0.1 (PET-355). Nothing about this integration widens that bind.
    url: getEnvVar('MTRACE_URL', 'http://127.0.0.1:8237'),
    token: getEnvVar('MTRACE_API_TOKEN', ''),
    // Discord's deferred-reply window is 15 minutes, so the real ceiling is
    // patience. A deep trace crosses six hosts over SSH; 60s is generous.
    timeoutMs: parseInt(getEnvVar('MTRACE_TIMEOUT_MS', '60000'), 10),
  },
  alerts: {
    coalesceMs: parseInt(getEnvVar('ALERT_COALESCE_MS', '60000'), 10),
    statePath: getEnvVar('ALERT_STATE_PATH', ''),
  },
  httpServer: {
    enabled: getEnvVar('HTTP_SERVER_ENABLED', 'true') === 'true',
    port: parseInt(getEnvVar('HTTP_SERVER_PORT', '3015'), 10),
    alertToken: getEnvVar('ALERT_BEARER_TOKEN', ''),
  },
};

export default config;
