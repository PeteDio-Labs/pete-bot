/**
 * The Secrets screen's API, mounted under /api/keys behind the Access check of the dashboard app.
 *
 *   POST /api/keys/runs        { action, name? } starts keys.yml. Answers { requestId, run }.
 *   GET  /api/keys/runs/:id    the run's state by request id; `list` adds the parsed rows when it is done.
 *
 * Every write waits on Pedro's lab-write tap on GitHub, so a request here only asks. Nothing here reads or returns a
 * secret. The routes answer 404 until a token and an admin list are set, so an unconfigured host exposes nothing.
 *
 * ⚠ BROWSER WRITES ARE SAME-ORIGIN ONLY. The CORS handler in dashboard.ts covers GET /api/dashboard, so a page on
 * another origin (staging, the AWS dashboard) cannot preflight a POST here. This router also refuses a request whose
 * Origin header names another host, and it needs application/json, which a cross-site form cannot send.
 */
import express, { Router, type Request, type Response } from 'express';
import { KEY_ACTIONS, NAMED_ACTIONS, NAME_RE, REQUEST_ID_RE, newRequestId, type KeyAction, type KeysClient } from './client.js';
import { parseKeyList } from './list.js';

export interface KeysRouteDeps {
  client: KeysClient;
  /** Emails allowed to use /api/keys. Empty means nobody. */
  admins: string[];
  /** How long to look for the run before answering without it. */
  findTimeoutMs?: number;
  log?: (msg: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Writes allowed per hour, and the gap between two. A stolen session cannot flood the tap queue. */
const WRITES_PER_HOUR = 6;
const WRITE_GAP_MS = 5_000;

export function createKeysRouter(d: KeysRouteDeps, email: (req: Request) => string | undefined): Router {
  const r = Router();
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const writes: number[] = [];

  r.use((req, res, next) => {
    const who = email(req)?.toLowerCase();
    if (!who || !d.admins.includes(who)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  });

  const sameOrigin = (req: Request): boolean => {
    const o = req.header('origin');
    if (o === undefined) return true;
    try {
      return new URL(o).host === req.header('host');
    } catch {
      return false;
    }
  };

  r.post('/runs', express.json({ limit: '1kb', type: 'application/json' }), async (req: Request, res: Response) => {
    if (!req.is('application/json')) return void res.status(415).json({ error: 'send application/json' });
    if (!sameOrigin(req)) return void res.status(403).json({ error: 'forbidden' });
    const body = (req.body ?? {}) as { action?: unknown; name?: unknown };
    const action = body.action as KeyAction;
    if (typeof body.action !== 'string' || !KEY_ACTIONS.includes(action)) return void res.status(400).json({ error: `action must be one of ${KEY_ACTIONS.join(', ')}` });
    const named = NAMED_ACTIONS.includes(action);
    if (named && (typeof body.name !== 'string' || !NAME_RE.test(body.name))) return void res.status(400).json({ error: `${action} needs an agent name` });
    if (!named && body.name !== undefined) return void res.status(400).json({ error: `${action} takes no name` });
    const name = named ? (body.name as string) : undefined;

    if (action !== 'list') {
      const t = now();
      while (writes.length && t - writes[0]! > 3_600_000) writes.shift();
      if (writes.length >= WRITES_PER_HOUR) return void res.status(429).json({ error: 'too many key changes this hour; wait, or approve the ones already waiting' });
      if (writes.length && t - writes[writes.length - 1]! < WRITE_GAP_MS) return void res.status(429).json({ error: 'wait a few seconds between key changes' });
      writes.push(t);
    }

    const requestId = newRequestId(now());
    try {
      await d.client.dispatch(action, name, requestId);
      // Names and actions only. The log never carries a secret, because this process never has one.
      d.log?.(`keys ${action}${name ? ` ${name}` : ''} requested, ${requestId}`);
      const deadline = now() + (d.findTimeoutMs ?? 20_000);
      let run = await d.client.findRun(requestId);
      while (!run && now() < deadline) {
        await sleep(2_000);
        run = await d.client.findRun(requestId);
      }
      res.status(202).json({ requestId, action, name: name ?? null, run: run ? { url: run.url } : null });
    } catch (err) {
      d.log?.(`keys ${action} failed: ${(err as Error).message.slice(0, 120)}`);
      res.status(502).json({ error: `keys.yml was not started: ${(err as Error).message.slice(0, 120)}` });
    }
  });

  r.get('/runs/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!REQUEST_ID_RE.test(id)) return void res.status(400).json({ error: 'bad request id' });
    try {
      const run = await d.client.findRun(id);
      if (!run) return void res.json({ state: 'not_found' });
      if (run.status === 'waiting') return void res.json({ state: 'waiting_tap', url: run.url });
      if (run.status !== 'completed') return void res.json({ state: run.status === 'queued' ? 'queued' : 'running', url: run.url });
      const ok = run.conclusion === 'success';
      const out: Record<string, unknown> = { state: ok ? 'done' : 'failed', conclusion: run.conclusion, url: run.url };
      if (ok) {
        try {
          const list = parseKeyList(await d.client.jobLog(run.id));
          if (list) out.list = list;
        } catch (err) {
          out.logError = (err as Error).message.slice(0, 120);
        }
      }
      res.json(out);
    } catch (err) {
      res.status(502).json({ error: `GitHub could not be read: ${(err as Error).message.slice(0, 120)}` });
    }
  });

  return r;
}
