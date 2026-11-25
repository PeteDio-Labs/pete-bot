import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { meter, readout, verdict } from 'toonish-ui/markup';
import { Html } from './html.tsx';
import { ACTION_WORD, CALLERS_EDIT, EXAMPLE_LIST, VAULT_KEYS, agedList, follow, keyLine, keysVerdict, type ChangeAction, type KeyList, type KeyRow, type KeysApi, type RunRead } from './keys.ts';

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
export function Secrets({ api, active, readonly = false, fed = null, whyNot = 'The lab has not sent its key list to this dashboard yet.', now = Date.now }: { api: KeysApi | null; active: boolean; readonly?: boolean; fed?: Fed | null; whyNot?: string; now?: () => number }) {
  if (!api && readonly) return <SecretsPreview fed={fed} whyNot={whyNot} now={now} />;
  return <SecretsLive api={api} active={active} />;
}


type Group = 'needs' | 'fine' | 'new';
const GROUPS: { id: Group; title: string; none: string }[] = [
  { id: 'needs', title: 'Needs you', none: 'Nothing needs you. No key is expired or due within 21 days.' },
  { id: 'fine', title: 'Fine', none: 'No key is in this group.' },
  { id: 'new', title: 'Not created', none: 'No key is waiting to be created.' },
];
const groupOf = (r: KeyRow): Group => (!r.hasToken ? 'new' : r.expired || r.renewSoon ? 'needs' : 'fine');
const days = (r: KeyRow): string => (r.expired ? 'Expired' : r.daysLeft === null ? 'Expiry unknown' : `${r.daysLeft} d left`);
const KEY_TERM = 90;

/** A state is a glyph and a word, never colour alone. */
function stateOf(r: KeyRow): { cls: string; text: string } {
  if (!r.hasToken) return { cls: 'toon-badge toon-badge-mist', text: '+ Not created' };
  if (r.expired) return { cls: 'toon-badge', text: '\u00d7 Expired' };
  if (r.renewSoon) return { cls: 'toon-badge toon-badge-yellow', text: '! Renew soon' };
  return { cls: 'toon-badge toon-badge-paper', text: '\u2713 Valid' };
}

function daysBar(r: KeyRow): string {
  const left = r.expired ? 0 : Math.max(0, r.daysLeft ?? 0);
  return meter({ label: 'Days left', value: left, max: KEY_TERM, clamp: true, tone: r.expired ? 'red' : r.renewSoon ? 'yellow' : 'green', valueText: days(r), id: `bar-${r.name.replace(/[^\w-]/g, '-')}` });
}

interface BoardProps {
  rows: KeyRow[];
  /** The read-only build: buttons look off and only open the steps. */
  preview: boolean;
  off: boolean;
  ask: (action: ChangeAction, name: string | null, from: string) => void;
  /** The buttons that sit in the bar beside the switch. */
  bar: ComponentChildren;
  vault?: boolean;
}

/**
 * The keys as one bar and three groups of rows. The switch picks Needs you or All. Each row is a native disclosure, so it
 * opens in place with no script, and its panel holds the days-left bar and the three changes with their one-line results.
 */
function KeyBoard({ rows, preview, off, ask, bar, vault = false }: BoardProps) {
  const [show, setShow] = useState<'needs' | 'all'>('all');
  const needs = rows.filter((r) => groupOf(r) === 'needs').length;
  const pick = (e: Event) => {
    const v = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')?.dataset.value;
    if (v === 'needs' || v === 'all') setShow(v);
  };
  return (
    <>
      <div class="dash-keybar">
        <div class="toon-seg" role="group" aria-label="Show keys" onClick={pick}>
          <button type="button" class="toon-seg-btn" aria-pressed={show === 'needs'} data-value="needs">Needs you <span class="toon-seg-count">{needs}</span></button>
          <button type="button" class="toon-seg-btn" aria-pressed={show === 'all'} data-value="all">All <span class="toon-seg-count">{rows.length}</span></button>
        </div>
        <div class="dash-actions">{bar}</div>
      </div>
      {GROUPS.filter((g) => show === 'all' || g.id === 'needs').map((g) => {
        const rs = rows.filter((r) => groupOf(r) === g.id);
        if (!rs.length && show === 'all') return null;
        return (
          <section class="dash-group" key={g.id} aria-labelledby={`grp-${g.id}`}>
            <h3 class="dash-group-h" id={`grp-${g.id}`}>{`${g.title} \u00b7 ${rs.length}`}</h3>
            {rs.length === 0 ? (
              <p class="dash-note">{g.none}</p>
            ) : (
              <div class="toon-list dash-keys" role="list" aria-label={g.title}>
                {rs.map((r) => {
                  const st = stateOf(r);
                  return (
                    <div class="toon-disclosure dash-key" role="listitem" key={r.name}>
                      <details class="toon-disclosure-details">
                        <summary class="toon-disclosure-btn">
                          <span class="toon-disclosure-lead toon-owner-a">KEY</span>
                          <span class="toon-disclosure-title"><b class="dash-key-name">{r.name}</b> <span class={st.cls}>{st.text}</span></span>
                          <span class="toon-disclosure-sub">{keyLine(r)}</span>
                          <span class="toon-disclosure-value toon-disclosure-note">{r.hasToken ? days(r) : 'In git'}</span>
                        </summary>
                        <div class="toon-disclosure-panel">
                          {r.hasToken ? (
                            <>
                              <Html html={daysBar(r)} />
                              <div class="dash-acts">
                                {(['renew', 'rotate', 'reissue'] as const).map((a) => (
                                  <>
                                    <button type="button" key={a} class={`toon-btn ${a === 'renew' ? '' : 'toon-btn-paper '}dash-btn${preview ? ' dash-btn-preview' : ''}`} disabled={off} aria-describedby={preview ? 'preview-note' : undefined} id={`key-${r.name}-${a}`} onClick={() => ask(a, r.name, `key-${r.name}-${a}`)}>{ACTION_WORD[a].label}<span class="sr-only">{` ${r.name}`}</span></button>
                                    <p>{ACTION_WORD[a].does}</p>
                                  </>
                                ))}
                              </div>
                              {vault && <p class="dash-actions"><a class="toon-btn toon-btn-paper dash-btn" href={VAULT_KEYS} target="_blank" rel="noopener noreferrer">Copy from Vault<span class="sr-only">{` for ${r.name}`}</span></a></p>}
                            </>
                          ) : (
                            <p>This key is in the list in git and does not exist yet. Apply changes creates it.</p>
                          )}
                        </div>
                      </details>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}

/** The list the lab last read and sent through the feed, with when. */
export interface Fed { list: KeyList; at: number }

function SecretsLive({ api, active }: { api: KeysApi | null; active: boolean }) {
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
        {list && list.rows.length > 0 ? (
          <KeyBoard rows={list.rows} preview={false} off={off} ask={ask} vault bar={<>
            <button type="button" class="toon-btn dash-btn" id="key-apply" disabled={off} onClick={() => ask('sync', null, 'key-apply')}>Apply changes</button>
            <a class="toon-btn toon-btn-paper dash-btn" href={CALLERS_EDIT} target="_blank" rel="noopener noreferrer" aria-label="Edit list on GitHub">Edit list</a>
            <button type="button" class="toon-btn toon-btn-paper dash-btn" disabled={off || loading} onClick={() => void refresh()}>Refresh the list</button>
          </>} />
        ) : (
          <p class="dash-actions">
            <a class="toon-btn toon-btn-paper dash-btn" href={CALLERS_EDIT} target="_blank" rel="noopener noreferrer" aria-label="Edit list on GitHub">Edit list</a>
            <button type="button" class="toon-btn toon-btn-paper dash-btn" disabled={off || loading} onClick={() => void refresh()}>Refresh the list</button>
          </p>
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
        <p class="dash-note">The key list is a file in git, so an addition or a removal is a pull request first. Edit it, merge, then Apply changes. A new key also needs its path in <code>secrets/register.yml</code>. A removed key also leaves each route’s <code>agents</code> list.</p>
      </div>
      <Html html={readout(list && seen.at ? `Read ${list.rows.length} keys at ${when(seen.at)}. ${list.read} No key value is read or shown here: copy a key from Vault, and every change waits for your tap on GitHub. ` : 'The key list has not been read.', { label: 'What was read' })} />
    </>
  );
}

function keysVerdictOff(): string {
  return verdict({ state: 'unknown', title: 'Keys cannot be managed from here', body: 'So it is unknown which keys are valid.' });
}

/**
 * The read-only Secrets screen (staging). It shows the list the lab sent through the feed. Its buttons open the same steps
 * as the live screen so the flow can be tried, and the last step cannot be taken: nothing is sent from here. With no list
 * yet it shows three labelled example rows, never a real key's name.
 */
function SecretsPreview({ fed, whyNot, now }: { fed: Fed | null; whyNot: string; now: () => number }) {
  const [asked, setAsked] = useState<Asked | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asked) cancelRef.current?.focus();
  }, [asked]);
  const at = now();
  // The flags are worked out again from each expiry date, so a list read hours ago does not show a key as healthy that has since crossed a line.
  const real = fed ? agedList(fed.list, at) : null;
  const list = real ?? EXAMPLE_LIST;
  const age = fed ? at - fed.at : null;
  const ask = (action: ChangeAction, name: string | null, from: string) => setAsked({ action, name, from });
  const cancel = () => {
    const from = asked?.from;
    setAsked(null);
    later(() => document.getElementById(from ?? '')?.focus());
  };
  return (
    <>
      <Html html={keysVerdict(real, real ? null : whyNot, age)} />
      <p class="toon-callout toon-callout-yellow dash-banner" id="preview-note">Staging is read-only. The buttons open the steps and send nothing.</p>
      <div class="dash-section">
        {!real && <p class="dash-note">These rows are examples so you can try the buttons. They are not your keys.</p>}
        <KeyBoard rows={list.rows} preview off={false} ask={ask} bar={<>
          <button type="button" class="toon-btn dash-btn dash-btn-preview" id="key-apply" aria-describedby="preview-note" onClick={() => ask('sync', null, 'key-apply')}>Apply changes</button>
          <a class="toon-btn toon-btn-paper dash-btn" href={CALLERS_EDIT} target="_blank" rel="noopener noreferrer" aria-label="Edit list on GitHub">Edit list</a>
        </>} />
        {asked && (
          <div class="dash-confirm-box" role="group" aria-label="Confirm the request">
            <p>{`${ACTION_WORD[asked.action].label}${asked.name ? ` ${asked.name}` : ''}: ${ACTION_WORD[asked.action].does} On the lab dashboard it runs only after you approve it on GitHub.`}</p>
            <p>Staging is read-only, so nothing is sent from here.</p>
            <p class="dash-confirm">
              <button type="button" class="toon-btn dash-btn dash-btn-off" disabled>{`Confirm: ask for ${ACTION_WORD[asked.action].label.toLowerCase()} (off on staging)`}</button>
              <button type="button" ref={cancelRef} class="toon-btn toon-btn-paper dash-btn" onClick={cancel}>Cancel</button>
            </p>
          </div>
        )}
        <p class="dash-note">{real ? 'The lab reads this list every 6 hours. Refresh it on the lab dashboard.' : 'When the lab has a list, it reads it every 6 hours and sends it here.'} The key list is a file in git, so an addition or a removal is a pull request first, then Apply changes on the lab dashboard.</p>
      </div>
      <Html html={readout(real && fed ? `Read ${real.rows.length} keys by the lab on ${new Date(fed.at).toISOString().slice(0, 10)} at ${when(fed.at)}, ${Math.max(0, Math.floor(age! / 3_600_000))} hours ago. ${real.read} No key value is read or shown here.` : `${whyNot} The rows above are examples.`, { label: 'What was read' })} />
    </>
  );
}
