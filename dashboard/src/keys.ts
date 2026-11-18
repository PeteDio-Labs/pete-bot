/**
 * The Secrets screen's model and client. Nothing here holds a key: the API returns names, owners, dates and run states.
 *
 * The client talks to pete-bot's /api/keys (src/keys/routes.ts), which starts the keys.yml workflow in petedio-iac. Every
 * change waits on the lab-write tap on GitHub, so a call here only asks.
 */
import { verdict } from 'toonish-ui/markup';

export const KEY_ACTIONS = ['list', 'sync', 'rotate', 'renew', 'reissue'] as const;
export type KeyAction = (typeof KEY_ACTIONS)[number];
export type ChangeAction = Exclude<KeyAction, 'list'>;

export interface KeyRow {
  name: string;
  owner: string;
  hasToken: boolean;
  version: string | null;
  expires: string | null;
  daysLeft: number | null;
  expired: boolean;
  renewSoon: boolean;
  inCallers: boolean;
}
export interface KeyList {
  rows: KeyRow[];
  read: string;
  unparsed: number;
}
export type RunState = 'queued' | 'running' | 'waiting_tap' | 'done' | 'failed' | 'not_found';
const RUN_STATES: readonly RunState[] = ['queued', 'running', 'waiting_tap', 'done', 'failed', 'not_found'];
export interface RunRead {
  state: RunState;
  url?: string;
  list?: KeyList;
  error?: string;
}
export interface KeysApi {
  start(action: KeyAction, name?: string): Promise<{ requestId: string; url: string | null }>;
  read(requestId: string, action: KeyAction): Promise<RunRead>;
}

/** Where a person edits the key list, and where an owner copies a key. The key itself never passes through this page. */
export const CALLERS_EDIT = 'https://github.com/PeteDio-Labs/petedio-iac/edit/main/secrets/callers.yml';
export const VAULT_KEYS = 'https://vault.pdlab.dev/ui/vault/secrets/kv/kv/list/callers/edge/';
export const KEYS_RUNS = 'https://github.com/PeteDio-Labs/petedio-iac/actions/workflows/keys.yml';

/**
 * The key API's address, or null. Only a path on this page's own origin counts: a cross-origin address could send a
 * signed-in person's request somewhere else, and the server refuses a cross-origin POST anyway.
 */
export function sameOriginPath(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return /^\/[A-Za-z0-9._~\/-]*$/.test(s) && !s.startsWith('//') && !s.includes('..') ? s.replace(/\/+$/, '') : null;
}

export const ACTION_WORD: Record<ChangeAction, { label: string; does: string }> = {
  renew: { label: 'Renew', does: 'Sets the key to 90 days from now. Its id and secret stay the same, so nothing else changes.' },
  rotate: { label: 'Rotate', does: 'Issues a new secret. The old one keeps working for 24 hours, so the owner can swap it.' },
  reissue: { label: 'Reissue', does: 'Replaces a lost key at once. The old secret stops, and the key id changes.' },
  sync: { label: 'Apply changes', does: 'Makes Cloudflare and Vault match the key list in git. It creates new keys and revokes keys that left the list.' },
};

export function keysApi(base: string, f: typeof fetch = fetch): KeysApi {
  const json = async (res: Response): Promise<Record<string, unknown>> => {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(body.error ?? `the server answered ${res.status}`).slice(0, 160));
    return body;
  };
  return {
    async start(action, name) {
      const res = await f(`${base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(name ? { action, name } : { action }), cache: 'no-store', credentials: 'same-origin' });
      const b = await json(res);
      const run = b.run as { url?: string } | null | undefined;
      return { requestId: String(b.requestId), url: run?.url ?? null };
    },
    async read(requestId, action) {
      const res = await f(`${base}/runs/${encodeURIComponent(requestId)}?action=${action}`, { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' });
      const b = await json(res);
      if (!RUN_STATES.includes(b.state as RunState)) throw new Error('the server sent a run state this page does not know');
      return { state: b.state as RunState, url: typeof b.url === 'string' ? b.url : undefined, list: b.list as KeyList | undefined, error: typeof b.logError === 'string' ? b.logError : undefined };
    },
  };
}

export interface FollowOptions {
  /** Called on every read, so the screen can show "waiting for your tap" while it waits. */
  onState?: (r: RunRead) => void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** How long to wait for the run, in ms. A write waits on a human, so it gets longer than a list. */
  limitMs: number;
  now?: () => number;
}

/** Reads a run until it ends. Every way out says what happened: a run that never appears or never ends comes back as a failure. */
export async function follow(api: KeysApi, requestId: string, action: KeyAction, o: FollowOptions): Promise<RunRead> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const now = o.now ?? Date.now;
  const end = now() + o.limitMs;
  let last: RunRead = { state: 'queued' };
  let misses = 0;
  let errors = 0;
  for (;;) {
    try {
      last = await api.read(requestId, action);
      errors = 0;
    } catch (err) {
      // One failed read says nothing about the run: a change may be waiting on a tap. Several in a row end the wait, and say so.
      if (++errors >= 4) return { state: 'failed', error: `the page could not read the run (${err instanceof Error ? err.message : 'unknown error'}), so the run may still be going` };
      if (now() >= end) return { state: 'failed', error: 'the run did not finish in time; check its page on GitHub' };
      await sleep(o.pollMs ?? 3_000);
      continue;
    }
    o.onState?.(last);
    if (last.state === 'done' || last.state === 'failed') return last;
    // A run GitHub has not listed yet reads as not_found for a few seconds. Many in a row means it never started.
    misses = last.state === 'not_found' ? misses + 1 : 0;
    if (misses >= 8) return { state: 'failed', error: 'the run never appeared on GitHub' };
    if (now() >= end) return { state: 'failed', url: last.url, error: 'the run did not finish in time; check its page on GitHub' };
    await sleep(o.pollMs ?? 3_000);
  }
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** One line about a key, for its row. */
export function keyLine(r: KeyRow): string {
  if (!r.hasToken) return 'Listed in git, not created yet. Apply changes creates it.';
  const exp = r.expires ? r.expires.slice(0, 10) : 'unknown';
  const left = r.expired ? 'expired' : r.daysLeft === null ? 'expiry unknown' : `${plural(r.daysLeft, 'day')} left`;
  return `Owner ${r.owner || 'unknown'}. Expires ${exp} (${left}).${r.inCallers ? '' : ' Not in git: Apply changes revokes it.'}`;
}

/** The answer the screen leads with. A list that was not read is unknown, never all clear. `verdict()` escapes its text, so nothing is escaped here. */
export function keysVerdict(list: KeyList | null, readError: string | null = null): string {
  if (!list) return verdict({ state: 'unknown', title: 'The key list was not read', body: readError ?? 'So it is unknown which keys are valid.' });
  const rows = list.rows;
  const expired = rows.filter((r) => r.expired);
  const soon = rows.filter((r) => !r.expired && r.renewSoon);
  const pending = rows.filter((r) => !r.hasToken || !r.inCallers);
  const names = (xs: KeyRow[]): string => xs.map((r) => r.name).join(', ');
  if (expired.length) return verdict({ state: 'down', stateText: 'Needs you', title: `${plural(expired.length, 'key')} expired`, body: `${names(expired)}. Reissue ${expired.length === 1 ? 'it' : 'them'} so the agent works again.` });
  if (soon.length) return verdict({ state: 'warn', stateText: 'Needs you soon', title: `${plural(soon.length, 'key')} expire${soon.length === 1 ? 's' : ''} within 21 days`, body: `${names(soon)}. Renew ${soon.length === 1 ? 'it' : 'them'} before then.` });
  if (pending.length) return verdict({ state: 'warn', stateText: 'Changes waiting', title: `${plural(pending.length, 'key')} differ${pending.length === 1 ? 's' : ''} from the list in git`, body: `${names(pending)}. Apply changes to make Cloudflare and Vault match.` });
  if (list.unparsed > 0) return verdict({ state: 'unknown', title: `${plural(list.unparsed, 'line')} of the key list could not be read`, body: 'So it is unknown whether every key is valid.' });
  if (rows.length === 0) return verdict({ state: 'unknown', title: 'No keys were listed', body: 'The run finished but listed no key, so it is unknown whether any key exists.' });
  const next = rows.reduce((m, r) => (r.daysLeft !== null && (m === null || r.daysLeft < m) ? r.daysLeft : m), null as number | null);
  return verdict({ state: 'ok', title: `All ${plural(rows.length, 'key')} are valid`, body: next === null ? 'Expiry dates were not readable.' : `The next one expires in ${plural(next, 'day')}.` });
}
