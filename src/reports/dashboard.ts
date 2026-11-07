/**
 * The weekly PR dashboard (PET-868): a read-only page and a JSON feed over the stored weeks.
 *
 *   GET /            the page
 *   GET /api/weeks   every stored week, newest first, plus any file that could not be read
 *   GET /api/reports        the other report kinds that have records
 *   GET /api/reports/:kind  one kind's records, newest first
 *   GET /health      no auth, no data: whether the store reads and when the last run happened
 *
 * ⚠ EVERY ROUTE BUT /health CHECKS THE ACCESS JWT. The listener is separate from the bot's
 * port 3015 so the alert intake is never reachable through this route. The origin firewall on
 * 237 admits only the tunnel host (LXC 112); the JWT check holds even if that rule is lost
 * (the lab MCP uses the same two checks, lab/access.ts).
 */
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { AccessResult } from '../lab/access.js';
import { DASHBOARD_HTML } from './dashboardPage.js';
import type { ReportHub } from './hub.js';
import type { WeekStore, WeeklyRunner } from './weekly.js';

export interface DashboardDeps {
  store: WeekStore;
  /** The other report kinds. Absent, the page shows the weekly report alone. */
  hub?: ReportHub;
  verify: (jwt: string | null) => Promise<AccessResult>;
  runner?: Pick<WeeklyRunner, 'last' | 'lastFailure'>;
  log?: (msg: string) => void;
}

export function createDashboardApp(d: DashboardDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/health', (_req, res) => {
    try {
      const weeks = d.store.weeks();
      // Flags only: error text can name internal URLs and this route takes no auth.
      res.json({ ok: true, weeks: weeks.length, newest: weeks[0] ?? null, lastRunOk: d.runner?.last ? d.runner.last.ok : null, everFailed: !!d.runner?.lastFailure });
    } catch (err) {
      res.status(503).json({ ok: false, error: (err as Error).message.slice(0, 120) });
    }
  });

  app.use(async (req, res, next) => {
    const access = await d.verify(req.header('cf-access-jwt-assertion') ?? null);
    if (!access.ok) {
      d.log?.(`dashboard refused: ${access.reason}`);
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  });

  app.get('/', (_req, res) => {
    res
      .type('html')
      // Inline script and style are this page's own; nothing loads from elsewhere.
      .setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'");
    res.send(DASHBOARD_HTML);
  });

  app.get('/api/weeks', (_req, res) => {
    try {
      res.json(d.store.all());
    } catch (err) {
      res.status(500).json({ error: `cannot read the store: ${(err as Error).message.slice(0, 120)}` });
    }
  });

  app.get('/api/reports', (_req, res) => {
    try {
      res.json({ kinds: d.hub ? d.hub.kinds() : [] });
    } catch (err) {
      res.status(500).json({ error: `cannot read the store: ${(err as Error).message.slice(0, 120)}` });
    }
  });

  app.get('/api/reports/:kind', (req, res) => {
    if (!d.hub) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    try {
      res.json(d.hub.list(req.params.kind));
    } catch (err) {
      const msg = (err as Error).message;
      res.status(msg.startsWith('bad report kind') ? 404 : 500).json({ error: msg.startsWith('bad report kind') ? 'not_found' : `cannot read the store: ${msg.slice(0, 120)}` });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  return app;
}

export function listenDashboard(app: Express, host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => resolve(s));
    s.on('error', reject);
  });
}
