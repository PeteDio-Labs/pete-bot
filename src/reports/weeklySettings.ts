/**
 * Settings for the weekly report and its dashboard (PET-868), checked once at startup.
 *
 * `off` (WEEKLY_REPORT_DIR empty) starts nothing. `misconfigured` starts nothing and /health
 * says why. A bad setting disables the weekly report, never the bot (settings.ts says why).
 * The dashboard needs the Access settings: with no AUD tag it does not start, so the page
 * is never served unauthenticated.
 */
export interface WeeklyEnv {
  WEEKLY_REPORT_DIR?: string;
  WEEKLY_DASH_HOST?: string;
  WEEKLY_DASH_PORT?: string;
  WEEKLY_ACCESS_TEAM_DOMAIN?: string;
  WEEKLY_ACCESS_AUD?: string;
  WEEKLY_ACCESS_EMAILS?: string;
  WEEKLY_OLLAMA_URL?: string;
}

export interface WeeklySettings {
  dir: string;
  host: string;
  port: number;
  teamDomain: string;
  aud: string;
  emails: string[];
  ollamaUrl: string;
}

export type WeeklyState = { state: 'off' } | { state: 'misconfigured'; reason: string } | { state: 'ready'; settings: WeeklySettings };

export function loadWeeklySettings(env: WeeklyEnv): WeeklyState {
  const dir = (env.WEEKLY_REPORT_DIR ?? '').trim();
  if (!dir) return { state: 'off' };
  const bad = (reason: string): WeeklyState => ({ state: 'misconfigured', reason });
  const portRaw = (env.WEEKLY_DASH_PORT ?? '').trim();
  const port = portRaw === '' ? 3018 : Number(portRaw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return bad(`WEEKLY_DASH_PORT must be 1024 to 65535, not "${portRaw}"`);
  const teamDomain = (env.WEEKLY_ACCESS_TEAM_DOMAIN ?? '').trim();
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) return bad('WEEKLY_ACCESS_TEAM_DOMAIN must look like <team>.cloudflareaccess.com');
  const aud = (env.WEEKLY_ACCESS_AUD ?? '').trim();
  if (!/^[0-9a-f]{64}$/.test(aud)) return bad('WEEKLY_ACCESS_AUD must be the 64-hex Access AUD tag');
  const emails = (env.WEEKLY_ACCESS_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (emails.length === 0) return bad('WEEKLY_ACCESS_EMAILS is empty');
  const ollamaUrl = (env.WEEKLY_OLLAMA_URL ?? '').trim().replace(/\/+$/, '') || 'http://192.168.50.246:11434';
  if (!/^https?:\/\//.test(ollamaUrl)) return bad(`WEEKLY_OLLAMA_URL must start with http:// or https://, not "${ollamaUrl}"`);
  return { state: 'ready', settings: { dir, host: (env.WEEKLY_DASH_HOST ?? '').trim() || '127.0.0.1', port, teamDomain, aud, emails, ollamaUrl } };
}
