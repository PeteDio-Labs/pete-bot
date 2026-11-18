import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardApp, STAGING_ORIGIN } from './dashboard.js';
import { WeekStore } from './weekly.js';

describe('CORS on /api/dashboard', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  async function call(method: string, origin: string | null, ok = true) {
    dir = mkdtempSync(join(tmpdir(), 'cors-'));
    const app = createDashboardApp({ store: new WeekStore(dir), services: async () => [], verify: async () => (ok ? { ok: true, email: 'p@x.dev' } : { ok: false, reason: 'x' }) });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { method, headers: origin ? { Origin: origin } : {} });
      return res;
    } finally {
      server.close();
    }
  }

  it('allows exactly the staging origin, with credentials, and varies on Origin', async () => {
    const res = await call('GET', STAGING_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(STAGING_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('sends no CORS header for another origin, a lookalike, or no origin', async () => {
    for (const o of ['https://evil.example', 'https://staging-dash.pdlab.dev.evil.example', 'http://staging-dash.pdlab.dev', null]) {
      const res = await call('GET', o);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
      expect(res.headers.get('vary')).toContain('Origin');
    }
  });

  it('answers the preflight for the staging origin only', async () => {
    expect((await call('OPTIONS', STAGING_ORIGIN, false)).status).toBe(204);
    expect((await call('OPTIONS', 'https://evil.example', false)).status).toBe(403);
  });

  it('still refuses an unauthenticated read', async () => {
    expect((await call('GET', STAGING_ORIGIN, false)).status).toBe(403);
  });
});
