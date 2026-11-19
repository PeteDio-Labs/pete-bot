/**
 * Reads the key list on a timer, so the cache has a list whether or not anyone opened the Secrets screen.
 *
 * It starts keys.yml `list`, which reads Vault metadata and asks for no tap, finds the run by its request id, waits for it,
 * and stores the parsed log. Every way out says what happened: a run that never appeared, never finished, failed, or
 * printed no key list leaves the last good list in place and logs the reason. Nothing here sees a key.
 */
import { newRequestId, type KeysClient } from './client.js';
import { parseKeyList } from './list.js';
import type { KeysCache } from './cache.js';

export type RefreshResult = { ok: true; rows: number } | { ok: false; reason: string };

export interface RefreshOptions {
  client: KeysClient;
  cache: KeysCache;
  /** How long to wait for the run to appear, and then to finish. */
  findMs?: number;
  runMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function refreshKeyList(o: RefreshOptions): Promise<RefreshResult> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const poll = o.pollMs ?? 5_000;
  const requestId = newRequestId(now());
  try {
    await o.client.dispatch('list', undefined, requestId);
    const findBy = now() + (o.findMs ?? 60_000);
    let run = await o.client.findRun(requestId);
    while (!run && now() < findBy) {
      await sleep(poll);
      run = await o.client.findRun(requestId);
    }
    if (!run) return { ok: false, reason: 'the run never appeared on GitHub' };
    const endBy = now() + (o.runMs ?? 300_000);
    while (run.status !== 'completed') {
      if (now() >= endBy) return { ok: false, reason: 'the run did not finish in time' };
      await sleep(poll);
      run = (await o.client.findRun(requestId)) ?? run;
    }
    if (run.conclusion !== 'success') return { ok: false, reason: `the run ended ${run.conclusion ?? 'without a conclusion'}` };
    const list = parseKeyList(await o.client.jobLog(run.id));
    if (!list) return { ok: false, reason: 'the run finished but its log had no key list' };
    if (list.rows.length === 0) return { ok: false, reason: 'the run listed no keys' };
    o.cache.set(list, new Date(now()));
    return { ok: true, rows: list.rows.length };
  } catch (err) {
    return { ok: false, reason: (err as Error).message.slice(0, 120) };
  }
}

/** Refreshes shortly after start and then every `everyMs`. Returns a stop function. One run at a time. */
export function startKeyRefresh(o: RefreshOptions & { everyMs?: number; firstMs?: number; log: (m: string) => void }): () => void {
  let running = false;
  const once = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const r = await refreshKeyList(o);
      o.log(r.ok ? `key list read: ${r.rows} keys` : `key list not read: ${r.reason}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void once(), o.firstMs ?? 90_000);
  const every = setInterval(() => void once(), o.everyMs ?? 6 * 3_600_000);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
