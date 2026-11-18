import { render } from 'preact';
import { useEffect, useRef, useState, useLayoutEffect } from 'preact/hooks';
import { tabbar } from 'toonish-ui/markup';
import { getFeed, type Feed } from './data.ts';
import { DEMO_SOURCE, clockFor, type DashboardData, type Side } from './model.ts';
import { QUESTIONS, actBlocks, healthBlocks, nowBlocks, section, serviceCard, servicesReadout, servicesRecord, servicesVerdict, workBlocks } from './views.ts';

export const TABS = [
  { id: 'now', label: 'Now' },
  { id: 'act', label: 'Act' },
  { id: 'services', label: 'Services' },
  { id: 'health', label: 'Health' },
  { id: 'work', label: 'Work' },
];
export const TABBAR = tabbar(TABS, { label: 'Dashboard sections', top: true });
const POLL_MS = 30_000;

type Load = { state: 'loading' } | { state: 'error'; message: string; data: DashboardData | null; problems: string[] } | { state: 'ready'; data: DashboardData; problems: string[]; readAt: number };

/**
 * One block of kit markup. Every string comes from the kit's escaping helpers or from esc() in views.ts.
 *
 * The feed is read again every 30 seconds, and an age such as "68 seconds ago" changes each time. Preact replaces a block
 * only when its string changed, and this component then puts back what the reader had: the rows they opened and the
 * control they had focus on. Without that, a poll would close an open row and drop a keyboard user to the top of the page.
 */
function Html({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const keyOf = (d: HTMLDetailsElement): string => d.querySelector('summary')?.id || d.querySelector('summary')?.textContent || '';
    const was = new Map([...el.querySelectorAll('details')].map((d) => [keyOf(d), d.open]));
    const active = document.activeElement;
    const focusId = active instanceof HTMLElement && el.contains(active) ? active.id : '';
    el.innerHTML = html;
    for (const d of el.querySelectorAll('details')) {
      const open = was.get(keyOf(d));
      if (open !== undefined) d.open = open;
    }
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  }, [html]);
  return <div class="dash-block" ref={ref} />;
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
  const side = (to: Side): string => (to === 'cloud' ? 'cloud' : 'on-prem');
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

export function App({ feed, now = () => Date.now() }: { feed: Feed; now?: () => number }) {
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
  const demo = data?.source === DEMO_SOURCE;
  const n = data ? clockFor(data, now()) : now();
  const problems = load.state === 'loading' ? [] : load.problems;
  return (
    <>
      {load.state === 'error' && <p class="toon-callout dash-banner" role="alert">{`The feed could not be read (${load.message}). ${data ? 'Showing the last data, which is out of date.' : 'Nothing is shown because nothing was read.'}`}</p>}
      {problems.length > 0 && <p class="toon-callout toon-callout-yellow dash-banner" role="status">{`Part of the feed was unreadable: ${problems.slice(0, 4).join('; ')}.`}</p>}
      {demo && <p class="toon-callout toon-callout-yellow dash-banner">{`Demo data. This is the fixture feed, shown as it read one minute after it was written (${data!.generatedAt.slice(0, 10)}). It reads nothing from the lab.`}</p>}
      {load.state === 'loading' && <p class="dash-loading" role="status">Reading the feed.</p>}
      <Panel id="now">{data && <Blocks blocks={nowBlocks(data, n)} />}</Panel>
      <Panel id="act">{data && <Blocks blocks={actBlocks(data, n)} />}</Panel>
      <Panel id="services">{data && <Services data={data} now={n} feed={feed} />}</Panel>
      <Panel id="health">{data && <Blocks blocks={healthBlocks(data, n)} />}</Panel>
      <Panel id="work">{data && <Blocks blocks={workBlocks(data, n)} />}</Panel>
    </>
  );
}

const root = typeof document !== 'undefined' ? document.getElementById('app') : null;
if (root) {
  render(<App feed={getFeed()} />, root);
  // The kit wires tabs and the other behaviour once, after the panels exist.
  void import('toonish-ui/toonish.js');
}
