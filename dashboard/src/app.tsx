import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { tabbar } from 'toonish-ui/markup';
import { getFeed, type Feed } from './data.ts';
import { type DashboardData, type Side } from './model.ts';
import { alertsView, cveView, nowView, planeView, serviceCards, watchdogMeters } from './views.ts';

export const TABS = [
  { id: 'now', label: 'Now' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'cve', label: 'CVE' },
  { id: 'services', label: 'Services' },
  { id: 'plane', label: 'Plane' },
];
export const TABBAR = tabbar(TABS, { label: 'Dashboard sections', top: true });
const POLL_MS = 30_000;

type Load = { state: 'loading' } | { state: 'error'; message: string; data: DashboardData | null; problems: string[] } | { state: 'ready'; data: DashboardData; problems: string[]; readAt: number };

function Html({ html }: { html: string }) {
  // Every string comes from the kit's escaping helpers or from esc() in views.ts.
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

function Panel({ id, title, children }: { id: string; title: string; children: preact.ComponentChildren }) {
  // `hidden` is left to the kit's script, which owns tab switching.
  return (
    <div class="toon-tabpanel" role="tabpanel" tabIndex={0} id={id} aria-labelledby={`${id}-tab`}>
      <h2 class="dash-h">{title}</h2>
      {children}
    </div>
  );
}

function Services({ data, now, feed }: { data: DashboardData; now: number; feed: Feed }) {
  const [asked, setAsked] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asked) confirmRef.current?.focus();
  }, [asked]);
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
  return (
    <>
      <p class="dash-examined">{`Read ${data.services.length} services, each side checked by its own watchdog. A missing or stale record shows as unknown.`}</p>
      <div class="toon-card dash-card"><Html html={watchdogMeters(data, now)} /></div>
      <ul class="dash-services" aria-label="Services">
        {data.services.map((s) => {
          const c = serviceCards(s, now);
          const can = c.sw.allowed && feed.requestSwitch !== null;
          const reason = feed.requestSwitch === null && c.sw.allowed ? 'This feed is read-only, so a switch cannot be requested here.' : c.sw.reason;
          return (
            <li class="dash-service" key={s.name}>
              <h3 class="dash-sname">{s.name}</h3>
              <p class="dash-meta">{`${s.hostname} · ${s.dataClass} · active on ${s.active === 'lab' ? 'on-prem' : 'cloud'}${s.pinned ? ' · pinned' : ''}`}</p>
              <p class={`dash-side dash-${c.lab.h}`}>{`On-prem: ${c.lab.text}`}</p>
              <p class={`dash-side dash-${c.cloud.h}`}>{`Cloud: ${c.cloud.text}`}</p>
              {asked === s.name ? (
                <p>
                  <button type="button" ref={confirmRef} class="toon-btn dash-btn" onClick={() => send(s.name, c.sw.to)}>{`Confirm: request switch to ${c.sw.to === 'cloud' ? 'cloud' : 'on-prem'}`}</button>{' '}
                  <button type="button" class="toon-btn toon-btn-ghost dash-btn" onClick={() => setAsked(null)}>Cancel</button>
                </p>
              ) : (
                <p>
                  <button type="button" class="toon-btn dash-btn" disabled={!can} aria-describedby={`why-${s.name}`} onClick={() => setAsked(s.name)}>{`Switch to ${c.sw.to === 'cloud' ? 'cloud' : 'on-prem'}`}</button>
                </p>
              )}
              <p class="dash-reason" id={`why-${s.name}`}>{reason}</p>
            </li>
          );
        })}
      </ul>
      <p class="dash-status" role="status" aria-live="polite">{msg}</p>
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
        if (alive) setLoad((prev) => ({ state: 'error', message: err instanceof Error ? err.message : 'unknown error', data: prev.state === 'loading' ? null : prev.data, problems: [] }));
      }
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [feed]);

  const data = load.state === 'loading' ? null : load.data;
  const n = now();
  const problems = load.state === 'loading' ? [] : load.problems;
  return (
    <>
      {load.state === 'error' && <p class="dash-banner" role="alert">{`The feed could not be read (${load.message}). ${data ? 'Showing the last data, which is out of date.' : 'Nothing is shown because nothing was read.'}`}</p>}
      {problems.length > 0 && <p class="dash-banner" role="status">{`Part of the feed was unreadable: ${problems.slice(0, 4).join('; ')}.`}</p>}
      {load.state === 'loading' && <p class="dash-examined" role="status">Reading the feed.</p>}
      <Panel id="now" title="Needs you"><Html html={data ? nowView(data, n) : ''} /></Panel>
      <Panel id="alerts" title="Alerts"><Html html={data ? alertsView(data, n) : ''} /></Panel>
      <Panel id="cve" title="CVE report"><Html html={data ? cveView(data, n) : ''} /></Panel>
      <Panel id="services" title="Services and switch">{data ? <Services data={data} now={n} feed={feed} /> : null}</Panel>
      <Panel id="plane" title="Plane"><Html html={data ? planeView(data, n) : ''} /></Panel>
    </>
  );
}

const root = typeof document !== 'undefined' ? document.getElementById('app') : null;
if (root) {
  render(<App feed={getFeed()} />, root);
  // The kit wires tabs and the other behaviour once, after the panels exist.
  void import('toonish-ui/toonish.js');
}
