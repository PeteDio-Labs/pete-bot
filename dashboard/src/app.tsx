import { render } from 'preact';
import { useEffect, useErrorBoundary, useRef, useState, useLayoutEffect } from 'preact/hooks';
import { Html } from './html.tsx';
import { tabbar, button } from 'toonish-ui/markup';
import { getFeed, type Feed } from './data.ts';
import { DEMO_SOURCE, clockFor, type DashboardData, type Side } from './model.ts';
import { Secrets, SECRETS_QUESTION } from './secrets.tsx';
import { keysApi, sameOriginPath, type KeysApi } from './keys.ts';
import { QUESTIONS, actBlocks, healthBlocks, nowBlocks, section, topBar, serviceCard, servicesReadout, servicesRecord, servicesVerdict, workBlocks } from './views.ts';

export const TABS = [
  { id: 'now', label: 'Now' },
  { id: 'act', label: 'Act' },
  { id: 'services', label: 'Services' },
  { id: 'health', label: 'Health' },
  { id: 'work', label: 'Work' },
];
export const TABBAR = tabbar(TABS, { label: 'Dashboard sections', top: true });
const POLL_MS = 30_000;
const DRAW_FAILED = 'This tab could not be drawn from the feed, so its state is unknown.';

type Load = { state: 'loading' } | { state: 'error'; message: string; data: DashboardData | null; problems: string[] } | { state: 'ready'; data: DashboardData; problems: string[]; readAt: number };

/**
 * A tab's blocks, or one block that says the tab could not be drawn. A kit helper throws on input it refuses, and one
 * odd value in the feed must not blank the page or leave an old answer standing.
 */
function safe(draw: () => string[]): string[] {
  try {
    return draw();
  } catch {
    return [`<p class="toon-callout dash-banner" role="alert">${DRAW_FAILED}</p>`];
  }
}

/** A tab's blocks in order: the answer, the evidence, what was read. */
function Blocks({ blocks }: { blocks: string[] }) {
  return <>{blocks.map((b, i) => <Html key={i} html={b} />)}</>;
}

function Panel({ id, children }: { id: keyof typeof QUESTIONS; children: preact.ComponentChildren }) {
  // `hidden` is left to the kit's script, which owns tab switching. The heading is the question the tab answers.
  return (
    <div class="toon-tabpanel dash-flow" role="tabpanel" tabIndex={0} id={id} aria-labelledby={`${id}-tab`}>
      <h2 class="toon-heading dash-q">{QUESTIONS[id]}</h2>
      {children}
    </div>
  );
}

/** The same rule for a tab that is a component: a throw while it draws shows the notice, not a blank page. */
function Guard({ children }: { children: preact.ComponentChildren }) {
  const [error] = useErrorBoundary();
  return error ? <p class="toon-callout dash-banner" role="alert">{DRAW_FAILED}</p> : <>{children}</>;
}

function Services({ data, now, feed }: { data: DashboardData; now: number; feed: Feed }) {
  const [asked, setAsked] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const confirmRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    if (asked) confirmRef.current?.focus();
  }, [asked]);
  const cards = data.services.map((s, i) => ({ s, id: `svc-${i}`, ...serviceCard(s, now, feed.requestSwitch !== null, `svc-${i}`) }));
  const send = async (service: string, to: Side) => {
    setAsked(null);
    if (!feed.requestSwitch) return setMsg('This feed cannot request a switch.');
    try {
      const r = await feed.requestSwitch(service, to);
      setMsg(`${service}: ${r.message}`);
    } catch (err) {
      setMsg(`${service}: the request did not reach the server (${err instanceof Error ? err.message : 'unknown error'}).`);
    }
  };
  // The kit's card has two buttons per service. A click on the idle side asks to confirm; the pressed side and a refused side do nothing.
  const onClick = (e: MouseEvent) => {
    const b = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-toon-switch-to]') : null;
    if (!b || b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-disabled') === 'true') return;
    const card = cards.find((c) => c.s.name === b.dataset.toonSwitch);
    if (card?.can && card.to === b.dataset.toonSwitchTo) setAsked(card.s.name);
  };
  const cancel = (id: string, to: Side) => {
    setAsked(null);
    // Back to the button that opened the confirm step.
    queueMicrotask(() => document.getElementById(`${id}-${to}`)?.focus());
  };
  const side = (to: Side): string => (to === 'cloud' ? 'cloud' : 'Lab');
  return (
    <>
      <Html html={servicesVerdict(data, now)} />
      {data.services.length > 0 && (
        <div class="dash-section">
          <Html html={section('01', 'Switch panel', '')} />
          <ul class="dash-services" aria-label="Services" ref={listRef} onClick={onClick}>
            {cards.map((c) => (
              <li class="dash-service" key={c.s.name}>
                <Html html={c.html} />
                {asked === c.s.name && c.can && (
                  <p class="dash-confirm">
                    <button type="button" ref={confirmRef} class="toon-btn dash-btn" onClick={() => send(c.s.name, c.to)}>{`Confirm: request switch to ${side(c.to)}`}</button>
                    <button type="button" class="toon-btn toon-btn-paper dash-btn" onClick={() => cancel(c.id, c.to)}>Cancel</button>
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p class="dash-status" role="status" aria-live="polite">{msg}</p>
        </div>
      )}
      <Html html={section('02', 'On record', servicesRecord(data, now))} />
      <Html html={servicesReadout(data, now)} />
    </>
  );
}

/** The key API named by `<meta name="dashboard-keys">`, or null. Only a path on this origin counts. */
export function getKeysApi(doc: Document = document): KeysApi | null {
  const base = sameOriginPath(doc.querySelector<HTMLMetaElement>('meta[name="dashboard-keys"]')?.content);
  return base ? keysApi(base) : null;
}

/** True while the address names the Secrets screen. The kit's tabs ignore a hash that is not a tab, so this view is the app's own. */
function useSecretsRoute(): boolean {
  const [on, setOn] = useState(() => typeof location !== 'undefined' && location.hash === '#secrets');
  useEffect(() => {
    const f = () => setOn(location.hash === '#secrets');
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return on;
}

export function App({ feed, keys = null, now = () => Date.now() }: { feed: Feed; keys?: KeysApi | null; now?: () => number }) {
  const secrets = useSecretsRoute();
  const headRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const main = document.getElementById('main');
    if (main) main.dataset.view = secrets ? 'secrets' : 'tabs';
    if (secrets) headRef.current?.focus({ preventScroll: false });
  }, [secrets]);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await feed.load();
        if (alive) setLoad({ state: 'ready', data: r.data, problems: r.problems, readAt: Date.now() });
      } catch (err) {
        if (alive) setLoad((prev) => ({ state: 'error', message: err instanceof Error ? err.message : 'unknown error', data: prev.state === 'loading' ? null : prev.data, problems: prev.state === 'loading' ? [] : prev.problems }));
      }
    };
    void tick();
    // A hook for the browser check, so it can read the feed again without waiting 30 seconds.
    (globalThis as { __dashPoll?: () => Promise<void> }).__dashPoll = tick;
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [feed]);

  const data = load.state === 'loading' ? null : load.data;
  const demo = feed.demo && data?.source === DEMO_SOURCE;
  const n = data ? clockFor(data, now(), feed.demo) : now();
  const problems = load.state === 'loading' ? [] : load.problems;
  // The header is the static bar from the build until a feed is read; then it says how many things need Pedro.
  useEffect(() => {
    const top = document.getElementById('top');
    if (!top) return;
    try {
      top.innerHTML = topBar(data, n);
    } catch {
      /* The static bar stays, and it makes no claim about state. */
    }
  }, [data, n]);
  return (
    <>
      {!secrets && load.state === 'error' && <p class="toon-callout dash-banner" role="alert">{`The feed could not be read (${load.message}). ${data ? 'Showing the last data, which is out of date.' : 'Nothing is shown because nothing was read.'}`}</p>}
      {!secrets && problems.length > 0 && <p class="toon-callout toon-callout-yellow dash-banner" role="status">{`Part of the feed was unreadable: ${problems.slice(0, 4).join('; ')}.`}</p>}
      {!secrets && demo && <p class="toon-callout toon-callout-yellow dash-banner">Demo data, not the lab.</p>}
      {!secrets && load.state === 'loading' && <p class="dash-loading" role="status">Reading the feed.</p>}
      <Panel id="now">{data && <Blocks blocks={safe(() => nowBlocks(data, n))} />}</Panel>
      <Panel id="act">{data && <Blocks blocks={safe(() => actBlocks(data, n))} />}</Panel>
      <Panel id="services">{data && <Guard><Services data={data} now={n} feed={feed} /></Guard>}</Panel>
      <Panel id="health">{data && <Blocks blocks={safe(() => healthBlocks(data, n))} />}</Panel>
      <Panel id="work">{data && <Blocks blocks={safe(() => workBlocks(data, n))} />}</Panel>
      <section class="dash-flow dash-secrets" id="secrets" aria-labelledby="secrets-h" hidden={!secrets}>
        <p class="dash-back" dangerouslySetInnerHTML={{ __html: button({ label: 'Back to dashboard', href: '#now', direction: 'back', cls: 'dash-btn' }) }} />
        <h2 class="toon-heading dash-q" id="secrets-h" tabIndex={-1} ref={headRef}>{SECRETS_QUESTION}</h2>
        <Guard><Secrets api={keys} active={secrets} /></Guard>
      </section>
    </>
  );
}

const root = typeof document !== 'undefined' ? document.getElementById('app') : null;
if (root) {
  render(<App feed={getFeed()} keys={getKeysApi()} />, root);
  // The kit wires tabs and the other behaviour once, after the panels exist.
  void import('toonish-ui/toonish.js');
}
