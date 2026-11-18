/** The kit's markup helpers, wrapped per section. Every helper escapes its input; this file adds no raw HTML from data. */
import { bars, delta, disclosure, list, meter, meters, spark, statusTile, uptime, esc } from 'toonish-ui/markup';
import { ageText, STALE_MS, healthOf, sortFindings, switchState, type DashboardData, type Health, type ServiceRow } from './model.ts';

const HEALTH_WORD: Record<Health, string> = { ok: 'healthy', down: 'down', unknown: 'unknown' };
const HEALTH_MARK: Record<Health, string> = { ok: '● ', down: '▲ ', unknown: '? ' };

const p = (text: string, cls = ''): string => `<p class="${cls}">${esc(text)}</p>`;
/** What the section read, always first. */
const examined = (text: string): string => `<p class="dash-examined">${esc(text)}</p>`;

/** Needs and alerts carry no time of their own, so they are unread when the feed said so or when the feed itself is older than STALE_MS (a cached copy after failed polls). */
export function liveUnread(d: DashboardData, now: number, key: 'needs' | 'alerts'): boolean {
  const at = Date.parse(d.generatedAt);
  return d.unread.includes(key) || !Number.isFinite(at) || now - at > STALE_MS;
}

/** The CVE run is daily, so one older than two days is out of date. */
const CVE_STALE_MS = 48 * 3_600_000;

export function nowView(d: DashboardData, now: number): string {
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
  const read = `Read ${plural(d.alerts.length, 'alert')}, ${plural(d.services.length, 'service')} and ${plural(d.needs.length, 'item')} that ${d.needs.length === 1 ? 'needs' : 'need'} you, ${ageText(d.generatedAt, now)}. Source: ${d.source}.`;
  if (liveUnread(d, now, 'needs')) return examined(`The list of items that need you was not read in full or is out of date, so it is unknown whether anything needs you. ${read}`);
  if (d.needs.length === 0) {
    const down = d.alerts.filter((a) => a.state === 'down').length;
    if (down > 0) return examined(read) + p(`No action card was written, but ${down} alert${down === 1 ? ' is' : 's are'} down. Open the Alerts tab: a missing card does not mean nothing is wrong.`);
    if (liveUnread(d, now, 'alerts')) return examined(read) + p('No action card was written, but the alert list was not read in full, so it is unknown whether anything is wrong. Open the Alerts tab.');
    return examined(read) + p('Nothing needs you. Every item above was read and none asks for a step.', 'dash-calm');
  }
  const rows = d.needs.map((n, i) =>
    disclosure({ id: `need-${i}`, lead: String(i + 1).padStart(2, '0'), title: n.title, value: ageText(n.since, now), native: true, open: i === 0, panel: `<p><strong>Why.</strong> ${esc(n.why)}</p><p><strong>Do this.</strong> ${esc(n.step)}</p>` }),
  );
  return examined(read) + list(rows, { label: 'Items that need you' });
}

export function alertsView(d: DashboardData, now: number): string {
  const t = d.triage;
  const ledger = t ? `Triage read ${t.read} alerts since ${t.since}: ${t.cards} cards, ${t.plain} plain, ${t.failures} Qwen failures.` : 'The triage ledger is missing, so card and fallback counts are unknown.';
  if (liveUnread(d, now, 'alerts') && d.alerts.length === 0) return examined(`The alert list was not read in full or is out of date, so it is unknown whether any alert is open. ${ledger}`);
  if (d.alerts.length === 0) return examined(`Read 0 alerts. ${ledger}`) + p('No alert records were returned.');
  const word = { act: 'Needs you', no_action: 'No action', unreadable: 'Triage unreadable, plain alert sent', off: 'No triage result' } as const;
  const rows = d.alerts.map((a, i) =>
    disclosure({ id: `alert-${i}`, lead: a.state === 'down' ? '▲' : '●', title: `${a.monitor} is ${a.state}`, value: ageText(a.since, now), native: true, panel: `<p>${esc(word[a.triage])}.</p>${a.why ? `<p><strong>Why.</strong> ${esc(a.why)}</p>` : ''}${a.step ? `<p><strong>Do this.</strong> ${esc(a.step)}</p>` : ''}` }),
  );
  const caveat = liveUnread(d, now, 'alerts') ? ' This list is partial or out of date, so an open alert may be missing.' : '';
  return examined(`Read ${d.alerts.length} alerts.${caveat} ${ledger}`) + list(rows, { label: 'Alerts' });
}

export function cveView(d: DashboardData, now: number): string {
  const c = d.cve;
  if (!c) return examined('The CVE report was not read, so the findings are unknown.');
  const gaps = c.gaps.length ? ` The run could not examine: ${c.gaps.join('; ')}.` : '';
  const kevNote = c.kevChecked ? '' : ' The exploited-vulnerability list was not read, so no finding is marked as exploited.';
  const read = `Read ${c.packages} package versions on ${c.hosts} hosts against ${c.advisories} advisories, ${ageText(c.checkedAt, now)}.${c.notChecked.length ? ` Not checked: ${c.notChecked.join(', ')}.` : ''}${gaps}${kevNote}`;
  if (c.findings.length === 0) return examined(read) + p(c.gaps.length || !c.kevChecked ? 'No finding was returned, but the run did not examine everything, so this is not a clean result.' : 'No exploited or high-severity finding has a fix.');
  const capNote = c.exploited !== null && c.exploited > c.findings.filter((f) => f.kev).length ? p(`The list shows ${c.findings.length} findings. The run found ${c.exploited} exploited in all, so the list is capped.`) : '';
  const sorted = sortFindings(c.findings);
  const rows = sorted.map((f, i) =>
    disclosure({ id: `cve-${i}`, lead: f.kev ? 'KEV' : ({ critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW' } as const)[f.severity], title: `${f.id} in ${f.pkg}`, value: f.severity, native: true, panel: `<p><strong>Host.</strong> ${esc(f.host)}</p><p><strong>Fix.</strong> ${f.fixed ? `Upgrade to ${esc(f.fixed)}.` : 'No fixed version is published.'}</p>${f.kev ? '<p>Exploited in the wild (CISA KEV).</p>' : ''}` }),
  );
  return examined(read) + capNote + list(rows, { label: 'CVE findings' });
}

function sideLine(s: ServiceRow['lab'], now: number): { h: Health; text: string } {
  const h = healthOf(s, now);
  return { h, text: `${HEALTH_MARK[h]}${HEALTH_WORD[h]}${s ? `, ${ageText(s.checkedAt, now)}` : ', no record'}` };
}

/** The switch panel. The button is rendered by the app (it needs a handler); this gives each row's facts. */
export function serviceCards(s: ServiceRow, now: number) {
  const lab = sideLine(s.lab, now);
  const cloud = sideLine(s.cloud, now);
  return { lab, cloud, sw: switchState(s, now) };
}

export function watchdogMeters(d: DashboardData, now: number): string {
  const checks = d.services.flatMap((s) => [healthOf(s.lab, now), healthOf(s.cloud, now)]);
  const ok = checks.filter((h) => h === 'ok').length;
  const down = checks.filter((h) => h === 'down').length;
  const unknown = checks.length - ok - down;
  const partial = d.droppedServices > 0 ? ` (${d.droppedServices} service row${d.droppedServices === 1 ? '' : 's'} unreadable, not counted)` : '';
  return meters(
    [
      meter({ label: 'Probes healthy', value: ok, max: Math.max(1, checks.length), tone: 'mist', valueText: `${ok} of ${checks.length}`, id: 'm-ok' }),
      meter({ label: 'Probes down', value: down, max: Math.max(1, checks.length), tone: 'red', valueText: `${down} of ${checks.length}`, id: 'm-down' }),
      meter({ label: 'Probes unknown', value: unknown, max: Math.max(1, checks.length), tone: 'yellow', valueText: `${unknown} of ${checks.length}`, id: 'm-unk' }),
    ],
    { label: `Watchdog summary${partial}` },
  );
}

export function planeView(d: DashboardData, now: number): string {
  const pl = d.plane;
  if (!pl) return examined('The Plane summary was not read, so the counts are unknown.');
  const lost = pl.lost && pl.lost > 0 ? ` ${pl.lost} item${pl.lost === 1 ? '' : 's'} in the cycle could not be found on the board, so these counts are incomplete.` : '';
  const cyc = pl.cycle ? ` Current cycle: ${esc(pl.cycle)}.` : '';
  return examined(`Read the PET board from the mirror, ${ageText(pl.checkedAt, now)}.${cyc}${lost}`) + list([
    disclosure({ id: 'pl-open', lead: '01', title: 'Open items', value: String(pl.open), native: true, panel: p('Items not in a done or cancelled state.') }),
    disclosure({ id: 'pl-np', lead: '02', title: 'Need Pedro', value: String(pl.needsPedro), native: true, panel: p('Items labelled needs-pedro.') }),
    disclosure({ id: 'pl-ir', lead: '03', title: 'In review', value: String(pl.inReview), native: true, panel: p('Items waiting on a review.') }),
  ], { label: 'Plane summary' });
}

export { delta, spark };

// ---- Charts. Each is the kit's `bars()` with a key that names every tone in words and a table with the same numbers. ----

interface Series { label: string; tone: 'red' | 'yellow' | 'violet' | 'blue' | 'mist' | 'hatch' }

const key = (series: Series[]): string =>
  `<ul class="toon-bars-key" aria-label="Chart key">${series.map((s) => `<li><i style="--toon-dot:${s.tone === 'hatch' ? '#4a4d78' : `var(--color-toon-${s.tone}, #3d7bff)`}" aria-hidden="true"></i>${esc(s.label)}</li>`).join('')}</ul>`;

/** The numbers behind a chart, for anyone who cannot read the bars. */
function table(caption: string, head: string[], rows: string[][]): string {
  return `<details class="dash-table"><summary>Show ${esc(caption)} as a table</summary><table><caption>${esc(caption)}</caption><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr><th scope="row">${esc(r[0] ?? '')}</th>${r.slice(1).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
}

/** The kit draws charts for paper, so each sits in a card. */
const card = (html: string): string => `<div class="toon-card dash-card">${html}</div>`;

const shortDay = (d: string): string => d.slice(5);

export function alertVolumeChart(d: DashboardData): string {
  const h = d.history;
  if (!h) return examined('The alert history was not read, so there is no chart.');
  if (h.alerts.length === 0) return examined('Read 0 days of alert history.');
  const series: Series[] = [{ label: 'Needs you', tone: 'red' }, { label: 'No action', tone: 'mist' }, { label: 'Triage unreadable', tone: 'hatch' }];
  const total = h.alerts.reduce((a, x) => a + x.act + x.noAction + x.unreadable, 0);
  const chart = bars({
    label: 'Alerts per day',
    columns: h.alerts.map((x) => ({ label: shortDay(x.day), segments: [{ value: x.act, tone: 'red', label: 'needs you' }, { value: x.noAction, tone: 'mist', label: 'no action' }, { value: x.unreadable, tone: 'hatch', label: 'unreadable' }] })),
  });
  return examined(`Read ${h.alerts.length} days and ${total} alerts.`) + card(chart + key(series) + table('alerts per day', ['Day', 'Needs you', 'No action', 'Unreadable'], h.alerts.map((x) => [x.day, String(x.act), String(x.noAction), String(x.unreadable)])));
}

export function cveHistoryChart(d: DashboardData): string {
  const h = d.history;
  if (!h) return examined('The CVE history was not read, so there is no chart.');
  if (h.cve.length === 0) return examined('Read 0 days of CVE history.');
  const series: Series[] = [{ label: 'Critical', tone: 'red' }, { label: 'High', tone: 'yellow' }, { label: 'Medium', tone: 'violet' }, { label: 'Low', tone: 'hatch' }];
  const chart = bars({
    label: 'Open CVE findings with a fix, per day',
    columns: h.cve.map((x) => ({ label: shortDay(x.day), segments: [{ value: x.critical, tone: 'red', label: 'critical' }, { value: x.high, tone: 'yellow', label: 'high' }, { value: x.medium, tone: 'violet', label: 'medium' }, { value: x.low, tone: 'hatch', label: 'low' }] })),
  });
  return examined(`Read ${h.cve.length} days of CVE counts.`) + card(chart + key(series) + table('CVE findings per day', ['Day', 'Critical', 'High', 'Medium', 'Low'], h.cve.map((x) => [x.day, String(x.critical), String(x.high), String(x.medium), String(x.low)])));
}

export function drillChart(d: DashboardData): string {
  const h = d.history;
  if (!h) return examined('The drill history was not read, so there is no chart.');
  if (h.drills.length === 0) return examined('Read 0 failover drills. None has run yet.');
  const series: Series[] = [{ label: 'Detect', tone: 'yellow' }, { label: 'Flip', tone: 'violet' }, { label: 'Client recovers', tone: 'red' }];
  const ran = h.drills.filter((x) => x.result !== 'not injected');
  const chart = ran.length
    ? bars({ label: 'Failover drill time in seconds', columns: ran.map((x) => ({ label: x.label, sub: x.result, segments: [{ value: x.detectS, tone: 'yellow', label: 'detect' }, { value: x.flipS, tone: 'violet', label: 'flip' }, { value: x.clientS, tone: 'red', label: 'client recovers' }] })) })
    : '';
  const skipped = h.drills.length - ran.length;
  return examined(`Read ${h.drills.length} drills; ${ran.length} injected their fault and ${skipped} did not, which counts as not run, never as passed.`) + card(chart + (ran.length ? key(series) : '') + table('failover drills', ['Drill', 'Result', 'Detect (s)', 'Flip (s)', 'Client recovers (s)'], h.drills.map((x) => [x.label, x.result, String(x.detectS), String(x.flipS), String(x.clientS)])));
}

/** Four tiles for the top of the Now tab. A figure that was not read is `unknown` with no value, never a zero. */
export function tiles(d: DashboardData, now: number): string {
  const probes = d.services.flatMap((s) => [healthOf(s.lab, now), healthOf(s.cloud, now)]);
  const unknown = probes.filter((h) => h === 'unknown').length;
  const down = probes.filter((h) => h === 'down').length;
  const downAlerts = d.alerts.filter((a) => a.state === 'down').length;
  const cveAge = d.cve ? now - Date.parse(d.cve.checkedAt) : 0;
  const cveFresh = Number.isFinite(cveAge) && cveAge <= CVE_STALE_MS;
  const kev = d.cve && d.cve.kevChecked && cveFresh ? d.cve.exploited ?? d.cve.findings.filter((f) => f.kev).length : null;
  const t = [
    liveUnread(d, now, 'needs') ? statusTile({ label: 'Needs you', state: 'unknown' }) : statusTile({ label: 'Needs you', value: String(d.needs.length), state: d.needs.length ? 'warn' : 'ok', readAt: d.generatedAt }),
    liveUnread(d, now, 'alerts') ? statusTile({ label: 'Alerts down', state: 'unknown' }) : statusTile({ label: 'Alerts down', value: String(downAlerts), state: downAlerts ? 'down' : 'ok', readAt: d.generatedAt }),
    d.droppedServices > 0
      ? statusTile({ label: 'Probes', state: 'unknown', detail: `${d.droppedServices} service row${d.droppedServices === 1 ? '' : 's'} unreadable, so totals are incomplete` })
      : probes.length
      ? statusTile({ label: 'Probes', value: `${probes.length - unknown - down} of ${probes.length} healthy`, state: down ? 'down' : unknown ? 'warn' : 'ok', detail: unknown ? `${unknown} unknown` : undefined, readAt: d.generatedAt })
      : statusTile({ label: 'Probes', state: 'unknown' }),
    kev === null ? statusTile({ label: 'Exploited CVEs', state: 'unknown' }) : statusTile({ label: 'Exploited CVEs', value: String(kev), state: kev ? 'down' : d.cve!.gaps.length ? 'warn' : 'ok', detail: d.cve!.gaps.length ? 'run had gaps' : undefined, readAt: d.cve!.checkedAt }),
  ];
  return `<div class="toon-tiles">${t.join('')}</div>`;
}

/** One strip per service that has history. A service with none says so, never an empty strip that reads as healthy. */
export function uptimeStrips(d: DashboardData): string {
  const h = d.history;
  if (!h) return examined('The uptime history was not read, so there are no strips.');
  const parts = d.services.map((s) => {
    const cells = h.uptime[s.name];
    return cells?.length ? card(uptime({ label: `${s.name} uptime`, windowLabel: `last ${cells.length} readings`, cells })) : card(p(`${s.name}: no uptime history was read.`));
  });
  return parts.join('');
}
