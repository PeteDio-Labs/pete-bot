import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardApp } from './dashboard.js';
import { loadWeeklySettings } from './weeklySettings.js';
import { WeekStore } from './weekly.js';

describe('a service-token caller of the dashboard', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  async function call(method: string, path: string, kind: 'agent' | 'person') {
    dir = mkdtempSync(join(tmpdir(), 'agent-'));
    const verify = async () => ({ ok: true as const, email: kind === 'agent' ? 'agent:staging' : 'p@x.dev', kind });
    const app = createDashboardApp({ store: new WeekStore(dir), services: async () => [], summarize: async () => 'x', verify });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      return res.status;
    } finally {
      server.close();
    }
  }
  it('may read the feed', async () => {
    expect(await call('GET', '/api/dashboard', 'agent')).toBe(200);
  });
  it('may not write: the summary route refuses it, and a person still reaches it', async () => {
    expect(await call('POST', '/api/weeks/2026-11-09/summary', 'agent')).toBe(403);
    expect(await call('POST', '/api/weeks/2026-11-09/summary', 'person')).not.toBe(403);
  });
});

describe('WEEKLY_ACCESS_AGENTS', () => {
  const env = { WEEKLY_REPORT_DIR: '/d', WEEKLY_ACCESS_TEAM_DOMAIN: 'petedillo-labs.cloudflareaccess.com', WEEKLY_ACCESS_AUD: 'a'.repeat(64), WEEKLY_ACCESS_EMAILS: 'p@x.dev' };
  const id = `${'b'.repeat(32)}.access`;
  it('reads agents, defaults to none, and refuses a malformed list', () => {
    expect(loadWeeklySettings({ ...env, WEEKLY_ACCESS_AGENTS: `${id}=staging` })).toMatchObject({ state: 'ready', settings: { agents: { [id]: 'staging' } } });
    expect(loadWeeklySettings(env)).toMatchObject({ state: 'ready', settings: { agents: {} } });
    expect(loadWeeklySettings({ ...env, WEEKLY_ACCESS_AGENTS: 'nope=staging' })).toMatchObject({ state: 'misconfigured' });
  });
});
