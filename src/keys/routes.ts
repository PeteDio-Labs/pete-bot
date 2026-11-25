/**
 * The Secrets screen's API, mounted under /api/keys behind the Access check of the dashboard app.
 *
 *   POST /api/keys/runs        { action, name? } starts keys.yml. Answers { requestId, run }.
 *   GET  /api/keys/runs/:id?action=<a>   the run's state by request id. Pass the action you asked for: a `list` that
 *                              finishes but prints no rows reads as failed, never as done.
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
import type { KeysCache } from './cache.js';

export interface KeysRouteDeps {
  client: KeysClient;
  /** Emails allowed to use /api/keys. Empty means nobody. */
  admins: string[];
  /** How long to look for the run before answering without it. */
  findTimeoutMs?: number;
  /** Where a finished list is kept for the dashboard feed. Absent, a list is returned and not kept. */
  cache?: KeysCache;
  log?: (msg: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Writes allowed per hour, and the gap between two. A stolen session cannot flood the tap queue. */
const WRITES_PER_HOUR = 6;
const WRITE_GAP_MS = 5_000;
/** A list starts a real run and holds the request while it looks for it, so it has its own, wider limit. */
const LISTS_PER_HOUR = 30;
const LIST_GAP_MS = 3_000;

export function createKeysRouter(d: KeysRouteDeps, email: (req: Request) => string | undefined): Router {
  const r = Router();
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const writes: number[] = [];
  const lists: number[] = [];

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

    {
      const t = now();
      const isList = action === 'list';
      const log = isList ? lists : writes;
      while (log.length && t - log[0]! > 3_600_000) log.shift();
      if (log.length >= (isList ? LISTS_PER_HOUR : WRITES_PER_HOUR)) return void res.status(429).json({ error: isList ? 'too many refreshes this hour' : 'too many key changes this hour; wait, or approve the ones already waiting' });
      if (log.length && t - log[log.length - 1]! < (isList ? LIST_GAP_MS : WRITE_GAP_MS)) return void res.status(429).json({ error: 'wait a few seconds' });
      log.push(t);
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
    const asked = req.query.action;
    if (asked !== undefined && !(typeof asked === 'string' && KEY_ACTIONS.includes(asked as KeyAction))) return void res.status(400).json({ error: 'bad action' });
    try {
      const run = await d.client.findRun(id);
      if (!run) return void res.json({ state: 'not_found' });
      if (run.status === 'waiting') return void res.json({ state: 'waiting_tap', url: run.url });
      if (run.status !== 'completed') return void res.json({ state: run.status === 'queued' ? 'queued' : 'running', url: run.url });
      const ok = run.conclusion === 'success';
      const out: Record<string, unknown> = { state: ok ? 'done' : 'failed', conclusion: run.conclusion, url: run.url };
      // A finished list that gives no rows is a failure, not a success with nothing in it.
      if (ok && asked === 'list') {
        try {
          const list = parseKeyList(await d.client.jobLog(run.id));
          if (list && list.rows.length > 0) {
            out.list = list;
            d.cache?.set(list, new Date(now()));
          } else if (list) Object.assign(out, { state: 'failed', logError: 'the run finished but listed no keys' });
          else Object.assign(out, { state: 'failed', logError: 'the run finished but its log had no key list' });
        } catch (err) {
          Object.assign(out, { state: 'failed', logError: (err as Error).message.slice(0, 120) });
        }
      }
      res.json(out);
    } catch (err) {
      res.status(502).json({ error: `GitHub could not be read: ${(err as Error).message.slice(0, 120)}` });
    }
  });

  return r;
}
