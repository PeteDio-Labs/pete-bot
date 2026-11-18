import { useEffect, useRef, useState } from 'preact/hooks';
import { readout, verdict } from 'toonish-ui/markup';
import { Html } from './html.tsx';
import { ACTION_WORD, CALLERS_EDIT, VAULT_KEYS, follow, keyLine, keysVerdict, type ChangeAction, type KeyList, type KeysApi, type RunRead } from './keys.ts';
import { section } from './views.ts';

export const SECRETS_QUESTION = 'Which keys can reach my lab, and does one expire soon?';

/** Seconds a list may take, and a change, which waits on a person's tap. */
const LIST_LIMIT_MS = 120_000;
const CHANGE_LIMIT_MS = 600_000;

interface Asked { action: ChangeAction; name: string | null; from: string }
interface Status { text: string; url: string | null; busy: boolean }
interface Seen { list: KeyList | null; at: number | null; error: string | null }

const when = (at: number): string => new Date(at).toISOString().slice(11, 16) + ' UTC';
const later = (f: () => void): void => void queueMicrotask(f);

/**
 * The Secrets screen. It lists the keys, and a button asks for a change. Nothing here reads a key: the owner copies it from
 * Vault. With no API this build cannot change keys, and the screen says so instead of showing buttons that do nothing.
 */
export function Secrets({ api, active }: { api: KeysApi | null; active: boolean }) {
  const [seen, setSeen] = useState<Seen>({ list: null, at: null, error: null });
  const [loading, setLoading] = useState(false);
  const [asked, setAsked] = useState<Asked | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const alive = useRef(true);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const busy = useRef(false);
  const started = useRef(false);
  const latest = useRef(0);
  useEffect(() => () => void (alive.current = false), []);
  useEffect(() => {
    if (asked) confirmRef.current?.focus();
  }, [asked]);

  // The newest read wins. An older list that finishes late is dropped, so it cannot overwrite a newer one.
  const refresh = async (): Promise<void> => {
    if (!api) return;
    const mine = ++latest.current;
    setLoading(true);
    try {
      const { requestId } = await api.start('list');
      const r = await follow(api, requestId, 'list', { limitMs: LIST_LIMIT_MS });
      if (!alive.current || mine !== latest.current) return;
      if (r.state === 'done' && r.list) setSeen({ list: r.list, at: Date.now(), error: null });
      else setSeen((p) => ({ ...p, error: r.error ?? 'the run did not finish' }));
    } catch (err) {
      if (alive.current && mine === latest.current) setSeen((p) => ({ ...p, error: err instanceof Error ? err.message : 'unknown error' }));
    } finally {
      if (alive.current && mine === latest.current) setLoading(false);
    }
  };
  // Read the list the first time the screen opens, and not before: a closed screen starts no run.
  useEffect(() => {
    if (active && api && !started.current) {
      started.current = true;
      void refresh();
    }
  }, [active, api]);

  const send = async (a: Asked): Promise<void> => {
    setAsked(null);
    if (!api || busy.current) return;
    busy.current = true;
    const label = `${ACTION_WORD[a.action].label}${a.name ? ` ${a.name}` : ''}`;
    setStatus({ text: `${label}: asking.`, url: null, busy: true });
    // The confirm step is gone, so focus goes to the line that reports what happens next.
    later(() => statusRef.current?.focus());
    try {
      const { requestId, url } = await api.start(a.action, a.name ?? undefined);
      const show = (r: RunRead) => {
        if (!alive.current) return;
        const link = r.url ?? url;
        setStatus({ busy: true, url: link, text: r.state === 'waiting_tap' ? `${label}: waiting for your tap. On GitHub, open Review deployments, then Approve.` : `${label}: asked. The run is ${r.state === 'not_found' ? 'starting' : r.state.replace('_', ' ')}.` });
      };
      const r = await follow(api, requestId, a.action, { limitMs: CHANGE_LIMIT_MS, onState: show });
      if (!alive.current) return;
      setStatus({ busy: false, url: r.url ?? url, text: r.state === 'done' ? `${label}: done.` : `${label}: did not finish${r.error ? ` (${r.error})` : ''}. Nothing is confirmed until the run on GitHub says so.` });
      if (r.state === 'done') void refresh();
    } catch (err) {
      if (alive.current) setStatus({ busy: false, url: null, text: `${label}: the request did not reach the server (${err instanceof Error ? err.message : 'unknown error'}).` });
    } finally {
      busy.current = false;
    }
  };
  const ask = (action: ChangeAction, name: string | null, from: string) => setAsked({ action, name, from });
  const cancel = () => {
    const from = asked?.from;
    setAsked(null);
    later(() => document.getElementById(from ?? '')?.focus());
  };

  if (!api) {
    return (
      <>
        <Html html={keysVerdictOff()} />
        <Html html={readout('This dashboard has no path to the lab’s key manager, so it shows no keys and offers no change. Open the lab dashboard to manage them.', { label: 'What was read' })} />
      </>
    );
  }

  const list = seen.list;
  const readError = seen.error ? `${seen.error}. ${list ? 'Showing the last list, which may be out of date.' : ''}`.trim() : null;
  const off = busy.current || status?.busy === true;
  return (
    <>
      {loading && !list ? <p class="dash-loading" role="status">Reading the keys. A run on the lab takes about a minute.</p> : <Html html={keysVerdict(list, readError)} />}
      <div class="dash-section">
        <Html html={section('01', 'Keys', '')} />
        {list && list.rows.length > 0 && (
          <ul class="dash-keys" aria-label="Keys">
            {list.rows.map((r) => (
              <li class="toon-card dash-key" key={r.name}>
                <b class="dash-key-name">{r.name}</b>
                <p class="dash-key-line">{keyLine(r)}</p>
                <p class="dash-actions">
                  {r.hasToken && (['renew', 'rotate', 'reissue'] as const).map((a) => (
                    <button type="button" key={a} class="toon-btn toon-btn-paper dash-btn" disabled={off} id={`key-${r.name}-${a}`} onClick={() => ask(a, r.name, `key-${r.name}-${a}`)}>{`${ACTION_WORD[a].label}`}<span class="sr-only">{` ${r.name}`}</span></button>
                  ))}
                  <a class="toon-btn toon-btn-paper dash-btn" href={VAULT_KEYS} target="_blank" rel="noopener noreferrer">Copy from Vault<span class="sr-only">{` for ${r.name}`}</span></a>
                </p>
              </li>
            ))}
          </ul>
        )}
        {asked && (
          <div class="dash-confirm-box" role="group" aria-label="Confirm the request">
            <p>{`${ACTION_WORD[asked.action].label}${asked.name ? ` ${asked.name}` : ''}: ${ACTION_WORD[asked.action].does} It runs only after you approve it on GitHub.`}</p>
            <p class="dash-confirm">
              <button type="button" ref={confirmRef} class="toon-btn dash-btn" onClick={() => void send(asked)}>{`Confirm: ask for ${ACTION_WORD[asked.action].label.toLowerCase()}`}</button>
              <button type="button" class="toon-btn toon-btn-paper dash-btn" onClick={cancel}>Cancel</button>
            </p>
          </div>
        )}
        <p class="dash-status" role="status" aria-live="polite" tabIndex={-1} ref={statusRef}>
          {status?.text}
          {status?.url && <>{' '}<a href={status.url} target="_blank" rel="noopener noreferrer">Open the run</a></>}
        </p>
        <p class="dash-actions">
          <button type="button" class="toon-btn toon-btn-paper dash-btn" disabled={off || loading} onClick={() => void refresh()}>Refresh the list</button>
        </p>
      </div>
      <div class="dash-section">
        <Html html={section('02', 'Add or remove a key', '')} />
        <p>The list of keys is a file in git, so an addition or a removal is a pull request first. Edit it on GitHub, merge, then apply the change here.</p>
        <p class="dash-actions">
          <a class="toon-btn toon-btn-paper dash-btn" href={CALLERS_EDIT} target="_blank" rel="noopener noreferrer">Edit the key list on GitHub</a>
          <button type="button" class="toon-btn toon-btn-paper dash-btn" id="key-apply" disabled={off} onClick={() => ask('sync', null, 'key-apply')}>Apply changes</button>
        </p>
        <p class="dash-note">A new key also needs its path in <code>secrets/register.yml</code>. A removed key also leaves each route’s <code>agents</code> list.</p>
      </div>
      <Html html={readout(list && seen.at ? `Read ${list.rows.length} keys at ${when(seen.at)}. ${list.read} No key value is read or shown here: copy a key from Vault, and every change waits for your tap on GitHub. ` : 'The key list has not been read.', { label: 'What was read' })} />
    </>
  );
}

function keysVerdictOff(): string {
  return verdict({ state: 'unknown', title: 'Keys cannot be managed from here', body: 'So it is unknown which keys are valid.' });
}
