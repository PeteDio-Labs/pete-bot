// Configuration module
import 'dotenv/config';

interface Config {
  discord: {
    token: string;
    clientId: string;
    allowedUsers: string[];
  };
  ollama: {
    host: string;
    model: string;
    timeout: number;
  };
  tools: {
    maxIterations: number;
  };
  summarizer: {
    enabled: boolean;
    model: string;
  };
  metrics: {
    enabled: boolean;
    port: number;
  };
  qbittorrent: {
    host: string;
    enabled: boolean;
  };
  missionControl: {
    url: string;
    enabled: boolean;
  };
  notificationService: {
    url: string;
  };
  eventStream: {
    enabled: boolean;
    ownerUserId: string;
    dedupWindowMs: number;
    triageTimeoutMs: number;
  };
  webSearchService: {
    url: string;
    enabled: boolean;
  };
  coder: {
    model: string;
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
  ollama: {
    host: getEnvVar('OLLAMA_HOST', 'http://localhost:11434'),
    model: getEnvVar('OLLAMA_MODEL', 'qwen2.5:7b'),
    timeout: parseInt(getEnvVar('OLLAMA_TIMEOUT', '120000'), 10),
  },
  tools: {
    maxIterations: 5,
  },
  summarizer: {
    enabled: getEnvVar('SUMMARIZER_ENABLED', 'true') === 'true',
    model: getEnvVar('SUMMARIZER_MODEL', 'qwen2.5:3b'),
  },
  metrics: {
    enabled: getEnvVar('METRICS_ENABLED', 'true') === 'true',
    port: parseInt(getEnvVar('METRICS_PORT', '9090'), 10),
  },
  qbittorrent: {
    host: getEnvVar('QBIT_HOST', 'http://192.168.50.21:8080'),
    enabled: getEnvVar('QBIT_ENABLED', 'true') === 'true',
  },
  missionControl: {
    url: getEnvVar('MISSION_CONTROL_URL', 'http://mission-control-backend.mission-control.svc.cluster.local:3000'),
    enabled: getEnvVar('MISSION_CONTROL_ENABLED', 'true') === 'true',
  },
  notificationService: {
    url: getEnvVar('NOTIFICATION_SERVICE_URL', 'http://notification-service.mission-control.svc.cluster.local:3002'),
  },
  eventStream: {
    enabled: getEnvVar('EVENT_STREAM_ENABLED', 'true') === 'true',
    ownerUserId: getEnvVar('OWNER_USER_ID', ''),
    dedupWindowMs: parseInt(getEnvVar('DEDUP_WINDOW_MS', '60000'), 10),
    triageTimeoutMs: parseInt(getEnvVar('TRIAGE_TIMEOUT_MS', '10000'), 10),
  },
  webSearchService: {
    url: getEnvVar('WEB_SEARCH_SERVICE_URL', 'http://web-search-service.web-search.svc.cluster.local:3003'),
    enabled: getEnvVar('WEB_SEARCH_ENABLED', 'true') === 'true',
  },
  coder: {
    model: getEnvVar('CODER_MODEL', 'petedio-coder'),
  },
};

export default config;
