// Configuration module
import 'dotenv/config';

interface Config {
  discord: {
    token: string;
    clientId: string;
    allowedUsers: string[];
  };
  metrics: {
    enabled: boolean;
    port: number;
  };
  missionControl: {
    url: string;
    enabled: boolean;
  };
  eventStream: {
    enabled: boolean;
    ownerUserId: string;
    dedupWindowMs: number;
  };
}

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name];
  if (!value && defaultValue === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value ?? defaultValue ?? '';
}

function parseAllowedUsers(ids: string | undefined): string[] {
  if (!ids) return [];
  return ids.split(',').map((id) => id.trim()).filter(Boolean);
}

export const config: Config = {
  discord: {
    token: getEnvVar('DISCORD_TOKEN'),
    clientId: getEnvVar('DISCORD_CLIENT_ID'),
    allowedUsers: parseAllowedUsers(process.env.ALLOWED_USER_IDS),
  },
  metrics: {
    enabled: getEnvVar('METRICS_ENABLED', 'true') === 'true',
    port: parseInt(getEnvVar('METRICS_PORT', '9090'), 10),
  },
  missionControl: {
    url: getEnvVar(
      'MISSION_CONTROL_URL',
      'http://mission-control-backend.mission-control.svc.cluster.local:3000',
    ),
    enabled: getEnvVar('MISSION_CONTROL_ENABLED', 'true') === 'true',
  },
  eventStream: {
    enabled: getEnvVar('EVENT_STREAM_ENABLED', 'true') === 'true',
    ownerUserId: getEnvVar('OWNER_USER_ID', ''),
    dedupWindowMs: parseInt(getEnvVar('DEDUP_WINDOW_MS', '60000'), 10),
  },
};

export default config;
