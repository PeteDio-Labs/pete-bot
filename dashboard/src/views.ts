/**
 * The kit's markup helpers, wrapped per tab. Every helper escapes its input; this file adds no raw HTML from data.
 *
 * Each tab answers one question, and leads with what Pedro can act on. Counts, charts and records sit under a row that
 * opens. Each tab answers one question, and its blocks come in one order: the answer (`verdict()`), the evidence in numbered
 * sections, then what was read (`readout()`). A `*Blocks` function returns those blocks one by one, so the page can replace
 * only a block whose text changed. The `*View` function of the same name joins them.
 */
import { bars, barsKey, chartTable, disclosure, kicker, list, meter, meters, readout, row, statusTile, strip, switchCard, uptime, verdict, esc, type TileState } from 'toonish-ui/markup';
import { ageText, backupState, isFresh, STALE_MS, healthOf, sortFindings, switchState, type DashboardData, type Health, type ServiceRow } from './model.ts';

/** The question each tab answers. It is the tab panel's heading. */
export const QUESTIONS = {
  now: 'Do I need to do anything?',
  act: 'What do I fix, in what order?',
  services: 'Can I fail over, and should I?',
  health: 'What is drifting toward trouble?',
  work: 'What is waiting on me, and what is stuck?',
} as const;

const p = (text: string, cls = ''): string => `<p${cls ? ` class="${cls}"` : ''}>${esc(text)}</p>`;
const plural = (n: number, w: string, many = `${w}s`): string => `${n} ${n === 1 ? w : many}`;
/** A numbered group of evidence under the answer. The label is an `h3`. */
const section = (num: string, label: string, html: string): string => `<div class="dash-section">${kicker(num, label, { heading: 3 })}${html}</div>`;
/** The kit draws charts and meters for paper, so each sits in a card. */
const card = (html: string): string => `<div class="toon-card dash-card">${html}</div>`;
/** Two labelled lines for a row's panel. Both values are escaped here. */
const kv = (pairs: [string, string][]): string => `<dl class="toon-kv">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;

/** Needs and alerts carry no time of their own, so they are unread when the feed said so or when the feed itself is older than STALE_MS (a cached copy after failed polls). */
export function liveUnread(d: DashboardData, now: number, key: 'needs' | 'alerts'): boolean {
  return d.unread.includes(key) || !isFresh(now - Date.parse(d.generatedAt), STALE_MS);
}

/** The CVE run is daily, so one older than two days is out of date. */
const CVE_STALE_MS = 48 * 3_600_000;
const cveIsFresh = (d: DashboardData, now: number): boolean => {
  return isFresh(d.cve ? now - Date.parse(d.cve.checkedAt) : Number.NaN, CVE_STALE_MS);
};
/** A run that read no host or no package examined nothing, so its empty list is not a clean result. */
const cveComplete = (c: NonNullable<DashboardData['cve']>): boolean => c.kevChecked && c.gaps.length === 0 && c.hosts > 0 && c.packages > 0;
/** The Plane summary comes from a report, so one older than two days is out of date. */
const planeFresh = (d: DashboardData, now: number): boolean => isFresh(d.plane ? now - Date.parse(d.plane.checkedAt) : Number.NaN, CVE_STALE_MS);

// ---- What needs fixing, in order ----

/** The workflow page where a lab action starts. It is the one place a step can be dispatched from a phone. */
export const LAB_ACTIONS = 'https://github.com/PeteDio-Labs/petedio-iac/actions/workflows/lab-action.yml';

type Tab = keyof typeof QUESTIONS;
const TAB_LABEL: Record<Tab, string> = { now: 'Now', act: 'Act', services: 'Services', health: 'Health', work: 'Work' };
/** A button-shaped link. A link to another tab is a hash, and the kit's script switches the tab on the hash change. */
const go = (href: string, text: string): string => `<p class="dash-go"><a class="toon-btn toon-btn-paper" href="${esc(href)}">${esc(text)}</a></p>`;
const tabLink = (tab: Tab, text = `Open ${TAB_LABEL[tab]}`): string => go(`#${tab}`, text);
const labLink = (): string => go(LAB_ACTIONS, 'Open lab actions');

/** The backup report is nightly, so one older than two days is out of date. */
const backupsFresh = (d: DashboardData, now: number): boolean => {
  return isFresh(d.backups ? now - Date.parse(d.backups.checkedAt) : Number.NaN, CVE_STALE_MS);
};
/** Whether a card's title names this guest's backup. Whole words, so a card for `plex-gpu` does not stand in for `plex`. */
const cardCovers = (title: string, guest: string): boolean => /backup/i.test(title) && title.toLowerCase().split(/[^a-z0-9-]+/).includes(guest.toLowerCase());

/** One thing to fix. `button` is trusted markup from `go()`. */
export interface ActItem {
  state: 'down' | 'warn';
  kind: 'SERVICE' | 'CARD' | 'ALERT' | 'CVE' | 'BACKUP';
  /** For a CVE: whether it is exploited. Now folds each class into one line. */
  exploited?: boolean;
  title: string;
  why: string;
  step: string;
  since?: string;
  note?: string;
  button: string;
}

/**
 * Everything with a step, most urgent first: a service down on the side that serves, the action cards, a down alert
 * with no card, exploited CVEs, a late backup, then critical and high CVEs that have a fix. A recovery is not an item.
 * A source that is unread or out of date adds nothing here; `attention()` and each view say that it was not read.
 */
export function actItems(d: DashboardData, now: number): ActItem[] {
  const out: ActItem[] = [];
  const needsRead = !liveUnread(d, now, 'needs');
  for (const s of d.services) {
    const side = s.active === 'lab' ? s.lab : s.cloud;
    if (healthOf(side, now) !== 'down') continue;
    const can = switchState(s, now).allowed;
    out.push({ state: 'down', kind: 'SERVICE', title: `${s.name} is down ${s.active === 'lab' ? 'in the Lab' : 'on cloud'}, the side that serves`, why: side?.detail ? `The watchdog read: ${side.detail}.` : 'The watchdog reported it down.', step: can ? 'It can switch sides now.' : 'It cannot switch sides now. Services says why.', since: side?.checkedAt, button: tabLink('services') });
  }
  if (needsRead) for (const n of d.needs) out.push({ state: 'warn', kind: 'CARD', title: n.title, why: n.why || 'No reason was given.', step: n.step, since: n.since, button: labLink() });
  // A down alert that triage turned into a card is already above as that card, when the cards were read.
  for (const a of d.alerts) if (a.state === 'down' && (a.triage !== 'act' || !needsRead)) out.push({ state: 'down', kind: 'ALERT', title: `${a.monitor} is down`, why: a.why || 'No action card was written for it. A missing card does not mean nothing is wrong.', step: a.step || 'No step was written. Read the monitor, then pick a lab action.', since: a.since, button: labLink() });
  const cves = d.cve && cveIsFresh(d, now) ? sortFindings(d.cve.findings) : [];
  const cveItem = (f: (typeof cves)[number], exploited: boolean): ActItem => ({
    state: exploited ? 'down' : 'warn', kind: 'CVE', exploited, title: `${f.id} in ${f.pkg}`, note: f.host || undefined,
    why: exploited ? 'Exploited in the wild, on the CISA KEV list.' : `A ${f.severity} finding with a fix published.`,
    step: f.fixed ? `Upgrade ${f.pkg} to ${f.fixed}${f.host ? ` on ${f.host}` : ''}.` : 'No fixed version is published. Watch the advisory.', button: labLink(),
  });
  const kevRead = !!d.cve && d.cve.kevChecked;
  for (const f of cves) if (kevRead && f.kev) out.push(cveItem(f, true));
  if (d.backups && backupsFresh(d, now)) {
    for (const b of d.backups.guests) {
      const st = backupState(b, now);
      // A card that names the guest's backup already carries this, with its step.
      if (st === 'ok' || (needsRead && d.needs.some((n) => cardCovers(n.title, b.guest)))) continue;
      out.push({ state: st, kind: 'BACKUP', title: b.lastGood ? `${b.guest}: the last good backup was ${ageText(b.lastGood, now)}` : `${b.guest} has no good backup on record`, why: b.detail || 'The nightly backup has not finished in time.', step: 'Run the backup job again, then check the free space on the backup store.', since: b.lastGood ?? undefined, button: labLink() });
    }
  }
  for (const f of cves) if (!(kevRead && f.kev) && f.fixed && (f.severity === 'critical' || f.severity === 'high')) out.push(cveItem(f, false));
  return out;
}

/** One line on Now, with the tab that holds its detail. */
export interface Attention {
  state: 'down' | 'warn' | 'unknown';
  /** A short mono word for the row's lead: where it came from. */
  kind: ActItem['kind'] | 'PLANE' | 'UNREAD';
  title: string;
  why: string;
  step?: string;
  since?: string;
  /** A short fact for the row's end slot, such as `1 exploited`. */
  fact?: string;
  tab: Tab;
}

/**
 * Now is the top of Act and the top of Work: every item to fix, with the CVEs folded into one line per class, then the
 * Plane items that wait on Pedro. A source that was not read comes last as `unknown`, so Now never reports all clear over
 * a source nobody read. A feed with no backup report is a gap that Health states; it does not hold Now at unknown.
 */
export function attention(d: DashboardData, now: number): Attention[] {
  const out: Attention[] = [];
  const items = actItems(d, now);
  const fold = (exploited: boolean): void => {
    const group = items.filter((i) => i.kind === 'CVE' && !!i.exploited === exploited);
    if (!group.length) return;
    const n = exploited && d.cve?.exploited ? Math.max(d.cve.exploited, group.length) : group.length;
    out.push({ state: exploited ? 'down' : 'warn', kind: 'CVE', title: exploited ? `${plural(n, 'CVE is', 'CVEs are')} exploited in the wild` : `${plural(n, 'critical or high CVE has', 'critical or high CVEs have')} a fix`, why: `First: ${group[0]!.title}${group[0]!.note ? ` on ${group[0]!.note}` : ''}.`, step: group[0]!.step, fact: `${n} ${exploited ? 'exploited' : 'fixable'}`, tab: 'act' });
  };
  let foldedKev = false, foldedRest = false;
  for (const i of items) {
    if (i.kind !== 'CVE') out.push({ state: i.state, kind: i.kind, title: i.title, why: i.why, step: i.step, since: i.since, tab: i.kind === 'SERVICE' ? 'services' : 'act' });
    else if (i.exploited && !foldedKev) (foldedKev = true), fold(true);
    else if (!i.exploited && !foldedRest) (foldedRest = true), fold(false);
  }
  if (d.plane && planeFresh(d, now) && d.plane.needsPedro > 0) {
    const mine = d.plane.detail?.items.filter((i) => i.needsPedro) ?? [];
    out.push({ state: 'warn', kind: 'PLANE', title: `${plural(d.plane.needsPedro, 'Plane item waits', 'Plane items wait')} on you`, why: mine[0] ? `First: PET-${mine[0].seq}, ${mine[0].name}.` : 'They carry the needs-pedro label.', fact: `${d.plane.needsPedro} waiting`, tab: 'work' });
  }
  if (liveUnread(d, now, 'needs')) out.push({ state: 'unknown', kind: 'UNREAD', title: 'The list of items that need you was not read', why: 'It was not read in full, or it is out of date.', tab: 'act' });
  if (liveUnread(d, now, 'alerts')) out.push({ state: 'unknown', kind: 'UNREAD', title: 'The alert list was not read in full', why: 'It was not read in full, or it is out of date, so an open alert may be missing.', tab: 'act' });
  if (!d.cve || !cveIsFresh(d, now)) out.push({ state: 'unknown', kind: 'UNREAD', title: d.cve ? 'The CVE report is out of date' : 'The CVE report was not read', why: d.cve ? `The last run was ${ageText(d.cve.checkedAt, now)}.` : 'The feed carried no CVE report.', tab: 'health' });
  else if (!d.cve.kevChecked) out.push({ state: 'unknown', kind: 'UNREAD', title: 'The exploited-vulnerability list was not read', why: 'So no finding is marked as exploited.', tab: 'health' });
  else if (!cveComplete(d.cve)) out.push({ state: 'unknown', kind: 'UNREAD', title: 'The CVE run did not examine everything', why: d.cve.gaps.length ? `${d.cve.gaps.join('; ')}.` : 'It read no host or no package.', tab: 'health' });
  if (d.unread.includes('backups')) out.push({ state: 'unknown', kind: 'UNREAD', title: 'The backup report was unreadable', why: 'The feed carried one, and it did not parse.', tab: 'health' });
  else if (d.backups && !backupsFresh(d, now)) out.push({ state: 'unknown', kind: 'UNREAD', title: 'The backup report is out of date', why: `It was last read ${ageText(d.backups.checkedAt, now)}.`, tab: 'health' });
  if (!d.plane) out.push({ state: 'unknown', kind: 'UNREAD', title: 'The Plane board was not read', why: 'So it is unknown what waits on you.', tab: 'work' });
  else if (!planeFresh(d, now)) out.push({ state: 'unknown', kind: 'UNREAD', title: 'The Plane board read is out of date', why: `It was last read ${ageText(d.plane.checkedAt, now)}.`, tab: 'work' });
  else if (d.plane.lost && d.plane.lost > 0) out.push({ state: 'unknown', kind: 'UNREAD', title: 'The Plane board counts are incomplete', why: `${plural(d.plane.lost, 'cycle item was', 'cycle items were')} not found on the board.`, tab: 'work' });
  if (d.services.length === 0) out.push({ state: 'unknown', kind: 'UNREAD', title: 'No service was read', why: 'So no probe stands behind this page.', tab: 'services' });
  const unknownProbes = d.services.flatMap((s) => [healthOf(s.lab, now), healthOf(s.cloud, now)]).filter((h) => h === 'unknown').length;
  if (unknownProbes > 0 || d.droppedServices > 0) out.push({ state: 'unknown', kind: 'UNREAD', title: unknownProbes ? `${plural(unknownProbes, 'probe has', 'probes have')} no fresh reading` : 'A service row was unreadable', why: 'A missing or stale watchdog record shows as unknown, never as healthy.', fact: unknownProbes ? `${unknownProbes} unread` : undefined, tab: 'services' });
  return out;
}

/** How many checks stand behind an all clear: each alert, each probe, each backup record and each report. */
const checksRead = (d: DashboardData): number => d.alerts.length + d.services.length * 2 + (d.backups?.guests.length ?? 0) + (d.cve ? 1 : 0) + (d.plane ? 1 : 0);

// ---- Now: do I need to do anything? ----

/** One plain line about the staging box, before what was read. Drawn only when the feed carries the clock. A stop by the limit is not "down". */
function stagingLine(d: DashboardData, now: number): string[] {
  const c = d.staging;
  if (!c) return [];
  const hours = (sec: number): string => `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  const age = ageText(c.checkedAt, now);
  const text =
    c.state === 'up' ? `Staging up ${hours(c.uptimeSec)}, shuts down at 24h (in ${hours(c.shutsDownInSec)}). Read ${age}.`
    : c.state === 'limit' ? `Staging stopped by the 24-hour limit. A new push starts a fresh 24 hours. Read ${age}.`
    : c.state === 'stopped' ? `Staging is stopped. Read ${age}.`
    : `The staging clock was not read: ${c.detail || 'no reason given'}.`;
  return [readout(text)];
}

export function nowBlocks(d: DashboardData, now: number): string[] {
  const blocks = nowCore(d, now);
  const last = blocks.length - 1;
  return [...blocks.slice(0, last), ...stagingLine(d, now), blocks[last]!];
}

function nowCore(d: DashboardData, now: number): string[] {
  const all = attention(d, now);
  const act = all.filter((a) => a.state !== 'unknown');
  const unread = all.filter((a) => a.state === 'unknown');
  const read = readout(`Read ${plural(checksRead(d), 'check')}, ${ageText(d.generatedAt, now)}: ${plural(d.alerts.length, 'alert')}, ${plural(d.services.length * 2, 'probe')}${d.backups ? `, ${plural(d.backups.guests.length, 'backup record')}` : ''}${d.cve ? ', the CVE report' : ''}${d.plane ? ', the Plane board' : ''}. Source: ${d.source}.`);
  const row = (a: Attention, i: number, open: boolean): string =>
    disclosure({
      id: `now-${i}`, tone: ({ down: 'red', warn: 'yellow', unknown: 'mist' } as const)[a.state], lead: a.state === 'unknown' ? a.kind : `${i + 1} ${a.kind}`, title: a.title, sub: a.why, note: a.since ? ageText(a.since, now) : a.fact ?? TAB_LABEL[a.tab], native: true, open,
      panel: (a.step ? kv([['Do this', a.step]]) : '') + tabLink(a.tab),
    });
  const unreadSection = (num: string): string[] => (unread.length ? [section(num, 'Not read', list(unread.map((a, i) => row(a, act.length + i, false)), { label: 'Sources that were not read' }))] : []);
  if (act.length) {
    const worst = act.find((a) => a.state === 'down') ?? act[0]!;
    const answer = verdict({
      state: worst.state, stateText: worst.state === 'down' ? 'Wrong now' : 'Needs you',
      title: act.length === 1 ? worst.title : `${act.length} things need you`,
      body: act.length === 1 ? worst.step ?? worst.why : `Start with: ${act[0]!.title}.`,
    });
    return [answer, section('01', 'In this order', list(act.map((a, i) => row(a, i, i === 0)), { label: 'What needs you, in order' })), ...unreadSection('02'), read];
  }
  if (liveUnread(d, now, 'needs')) return [verdict({ state: 'unknown', title: 'It is unknown whether anything needs you', body: 'The list of items that need you was not read in full, or it is out of date.' }), ...unreadSection('01'), read];
  if (liveUnread(d, now, 'alerts')) return [verdict({ state: 'unknown', title: 'No action card, but the alert list was not read in full', body: 'So it is unknown whether anything is wrong.' }), ...unreadSection('01'), read];
  if (unread.length) return [verdict({ state: 'unknown', stateText: 'Partly read', title: 'Nothing needs you in what was read', body: `${plural(unread.length, 'source was', 'sources were')} not read, so this is not an all clear.` }), ...unreadSection('01'), read];
  return [verdict({ state: 'ok', stateText: 'All clear', title: 'Nothing needs you', body: `Read ${plural(checksRead(d), 'check')}, ${ageText(d.generatedAt, now)}.` }), read];
}
export const nowView = (d: DashboardData, now: number): string => nowBlocks(d, now).join('');

// ---- Act: what do I fix, in what order? ----

export function actBlocks(d: DashboardData, now: number): string[] {
  const t = d.triage;
  const items = actItems(d, now);
  const partial = liveUnread(d, now, 'alerts') || liveUnread(d, now, 'needs');
  const cveListed = !!d.cve && cveIsFresh(d, now);
  const cveRead = cveListed && cveComplete(d.cve!);
  const backupsUsed = !!d.backups && backupsFresh(d, now);
  const caveat = `${partial ? ' The alert list or the card list is partial or out of date, so an item may be missing.' : ''}${cveListed ? (cveRead ? '' : ' The CVE run did not examine everything, so a CVE may be missing.') : ' The CVE report was not read, so no CVE is listed.'}${d.backups && !backupsUsed ? ' The backup report is out of date, so no backup is listed.' : ''}`;
  const word = { act: 'A card was written', no_action: 'No action needed', unreadable: 'Triage was unreadable, so a plain alert was sent', off: 'No triage result' } as const;
  // A recovery closes the alert it ends, so it is not an item. It stays on record here.
  const quiet = d.alerts.filter((a) => a.state === 'up');
  const record: string[] = [
    disclosure({ id: 'act-quiet', lead: 'UP', title: 'Recovered alerts', sub: 'Alerts that came back up. A recovery closes the alert, so none needs a step.', note: `${quiet.length} up`, native: true, panel: quiet.length ? list(quiet.map((a) => row({ lead: 'UP', title: a.monitor, sub: `${word[a.triage]}.`, aside: ageText(a.since, now) })), { label: 'Recovered alerts' }) : p('No recovered alert is on the list.') }),
    disclosure({
      id: 'act-triage', lead: 'TRIAGE', title: 'Triage record', sub: 'How Qwen sorted the alerts into action cards and plain alerts.', note: t ? `${t.read} read` : 'not read', native: true,
      panel: t ? strip([{ value: String(t.read), label: 'alerts read' }, { value: String(t.cards), label: 'action cards' }, { value: String(t.plain), label: 'plain alerts' }, { value: String(t.failures), label: 'Qwen failures' }], { label: `Triage since ${t.since}` }) + p(`Counted since ${t.since}. A failed triage sends the plain alert, never silence.`) : p('The triage ledger is missing, so card and fallback counts are unknown.'),
    }),
  ];
  const tail = (num: string): string => section(num, 'On record', list(record, { label: 'Recovered alerts and the triage record' }));
  const read = readout(`Read ${plural(d.alerts.length, 'alert')} and ${plural(d.needs.length, 'action card')}, ${ageText(d.generatedAt, now)}${d.cve ? `, and the CVE report of ${ageText(d.cve.checkedAt, now)}` : ''}${backupsUsed ? `, and ${plural(d.backups!.guests.length, 'backup record')}` : ''}.${caveat}`);
  if (!items.length) {
    const answer = partial
      ? verdict({ state: 'unknown', title: 'It is unknown whether anything needs a fix', body: caveat.trim() })
      : cveRead
      ? verdict({ state: 'ok', stateText: 'Nothing to fix', title: 'No item has a step for you', body: 'No alert is down, no card is open, and no exploited, critical or high CVE has a fix.' })
      : verdict({ state: 'unknown', stateText: 'Partly read', title: 'Nothing to fix in what was read', body: caveat.trim() });
    return [answer, tail('01'), read];
  }
  const worst = items.some((i) => i.state === 'down') ? 'down' : 'warn';
  const rows = items.map((it, i) =>
    disclosure({
      id: `act-${i}`, tone: it.state === 'down' ? 'red' : 'yellow', lead: `${i + 1} ${it.kind}`, title: it.title, sub: it.why, badge: it.exploited ? { text: 'Exploited', tone: 'red' } : undefined, note: it.note ?? (it.since ? ageText(it.since, now) : undefined), native: true, open: i === 0,
      panel: kv([['Do this', it.step]]) + it.button,
    }),
  );
  const answer = verdict({ state: worst, stateText: 'Fix', title: `${plural(items.length, 'thing')} to fix`, body: `Start with: ${items[0]!.title}. ${items[0]!.step}${caveat}` });
  return [answer, section('01', 'Fix in this order', list(rows, { label: 'What to fix, in order' })), tail('02'), read];
}
export const actView = (d: DashboardData, now: number): string => actBlocks(d, now).join('');

// ---- Health: what is drifting toward trouble? ----

interface Signal { label: string; state: TileState; value?: string; detail?: string; readAtText?: string; /** The sentence the answer uses when this is the worst signal. */ says: string }

/** The slow signals, one per source. A source that was not read is `unknown` with no value, never a zero. */
export function signals(d: DashboardData, now: number): Signal[] {
  const out: Signal[] = [];
  const b = d.backups;
  if (!b) out.push({ label: 'Backups', state: 'unknown', detail: d.unread.includes('backups') ? 'The backup report was unreadable' : 'The feed carries no backup report', says: 'The backups were not read' });
  else if (!backupsFresh(d, now)) out.push({ label: 'Backups', state: 'unknown', detail: `The report is from ${ageText(b.checkedAt, now)}`, says: 'The backup report is out of date' });
  else if (b.guests.length === 0) out.push({ label: 'Backups', state: 'unknown', detail: 'The report lists no guest', says: 'The backup report lists no guest' });
  else {
    const st = b.guests.map((g) => backupState(g, now));
    const bad = st.filter((x) => x !== 'ok').length;
    out.push({ label: 'Backups', state: st.includes('down') ? 'down' : bad ? 'warn' : 'ok', value: `${b.guests.length - bad} of ${b.guests.length} in time`, readAtText: ageText(b.checkedAt, now), says: `${plural(bad, 'guest has', 'guests have')} no backup in the last 36 hours` });
  }
  const c = d.cve;
  if (!c) out.push({ label: 'Patches', state: 'unknown', detail: 'The CVE report was not read', says: 'The CVE report was not read' });
  else if (!cveIsFresh(d, now)) out.push({ label: 'Patches', state: 'unknown', detail: `The last run was ${ageText(c.checkedAt, now)}`, says: 'The CVE report is out of date' });
  else {
    const kev = c.kevChecked ? Math.max(c.exploited ?? 0, c.findings.filter((f) => f.kev).length) : 0;
    const fixable = c.findings.filter((f) => f.fixed).length;
    const incomplete = !cveComplete(c);
    const state: TileState = kev > 0 ? 'down' : incomplete ? 'unknown' : fixable > 0 ? 'warn' : 'ok';
    out.push({ label: 'Patches', state, value: state === 'unknown' ? undefined : `${fixable} to apply`, detail: kev > 0 ? `${kev} exploited` : incomplete ? 'The run did not examine everything' : undefined, readAtText: ageText(c.checkedAt, now), says: kev > 0 ? `${plural(kev, 'finding is', 'findings are')} exploited in the wild` : incomplete ? 'The CVE run did not examine everything, so this is not a clean result' : `${plural(fixable, 'finding has', 'findings have')} a fix to apply` });
  }
  return out;
}
export const tiles = (d: DashboardData, now: number): string => `<div class="toon-tiles">${signals(d, now).map((s) => statusTile({ label: s.label, state: s.state, value: s.value, detail: s.detail, readAtText: s.readAtText })).join('')}</div>`;

export function healthBlocks(d: DashboardData, now: number): string[] {
  const sig = signals(d, now);
  const order = ['down', 'warn', 'unknown', 'ok'] as const;
  const worst = order.find((st) => sig.some((x) => x.state === st))!;
  const lead = sig.find((x) => x.state === worst)!;
  const others = sig.filter((x) => x !== lead && x.state !== 'ok').map((x) => `${x.says}.`).join(' ');
  const notRead = 'Drift and certificate expiry are not in the feed yet.';
  const answer = worst === 'ok'
    ? verdict({ state: 'ok', stateText: 'Steady', title: 'Backups and patches are in order', body: notRead })
    : verdict({ state: worst, stateText: worst === 'down' ? 'Drifting' : worst === 'warn' ? 'Watch' : undefined, title: lead.says, body: `${others ? `${others} ` : ''}${notRead}` });
  const blocks = [answer, section('01', 'Slow signals', tiles(d, now))];
  let n = 2;
  const num = (): string => String(n++).padStart(2, '0');
  const b = d.backups;
  if (b && b.guests.length) {
    const word = { ok: 'IN TIME', warn: 'LATE', down: 'MISSING' } as const;
    const rank = { down: 0, warn: 1, ok: 2 } as const;
    const rows = [...b.guests].sort((x, y) => rank[backupState(x, now)] - rank[backupState(y, now)]).map((g) => row({ leadTone: backupsFresh(d, now) ? ({ ok: 'blue', warn: 'yellow', down: 'red' } as const)[backupState(g, now)] : 'mist', lead: backupsFresh(d, now) ? word[backupState(g, now)] : 'UNKNOWN', title: g.guest, sub: g.detail || (!backupsFresh(d, now) ? 'The backup report is out of date, so this record may have changed.' : g.lastGood ? `Last good run ${ageText(g.lastGood, now)}.` : 'No good run is on record.'), aside: g.lastGood ? ageText(g.lastGood, now) : 'no good run', dot: backupsFresh(d, now) ? ({ ok: undefined, warn: 'yellow', down: 'red' } as const)[backupState(g, now)] : 'mist' }));
    blocks.push(section(num(), 'Last good backup per guest', list(rows, { label: 'Last good backup per guest' })));
  }
  const c = d.cve;
  if (c && c.findings.length) {
    const short = { critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW' } as const;
    const rows = sortFindings(c.findings).map((f, i) =>
      disclosure({
        id: `cve-${i}`, tone: ({ critical: 'red', high: 'red', medium: 'yellow', low: 'mist' } as const)[f.severity], lead: short[f.severity], title: `${f.id} in ${f.pkg}`, sub: f.fixed ? `Fixed in ${f.pkg} ${f.fixed}.` : 'No fixed version is published yet.', badge: f.kev && c.kevChecked ? { text: 'Exploited', tone: 'red' } : undefined, note: f.host || undefined, native: true,
        panel: kv([['Severity', f.severity], ['Host', f.host || 'unknown'], ['Fix', f.fixed ? `Upgrade to ${f.fixed}.` : 'No fixed version is published.'], ...(f.kev && c.kevChecked ? [['Exploited', 'In the wild, on the CISA KEV list.'] as [string, string]] : [])]),
      }),
    );
    blocks.push(section(num(), 'Patch backlog', list(rows, { label: 'CVE findings' })));
  }
  if (c) blocks.push(section(num(), 'What the CVE run covered', strip([{ value: String(c.packages), label: 'package versions' }, { value: String(c.hosts), label: 'hosts read' }, { value: String(c.advisories), label: 'advisories' }, { value: String(c.notChecked.length), label: c.notChecked.length === 1 ? 'host not checked' : 'hosts not checked' }], { label: 'What the CVE run covered' })));
  const lastA = d.history?.alerts.at(-1), lastC = d.history?.cve.at(-1);
  const trendAlerts = lastA ? `${lastA.act + lastA.noAction + lastA.unreadable} on ${shortDay(lastA.day)}` : 'not read';
  const trendCve = lastC ? `${lastC.critical + lastC.high + lastC.medium + lastC.low} open` : 'not read';
  blocks.push(section(num(), 'Trends', list([
    disclosure({ id: 'trend-alerts', lead: '7 DAYS', title: 'Alerts per day', sub: 'How many alerts fired each day this week.', note: trendAlerts, native: true, panel: alertVolumeChart(d) }),
    disclosure({ id: 'trend-cve', lead: '7 DAYS', title: 'Open CVE findings per day', sub: 'Whether the patch backlog is shrinking or growing.', note: trendCve, native: true, panel: cveHistoryChart(d) }),
  ], { label: 'Trends' })));
  const gaps = c && c.gaps.length ? ` The CVE run could not examine: ${c.gaps.join('; ')}.` : '';
  const kevNote = c && !c.kevChecked ? ' The exploited-vulnerability list was not read, so no finding is marked as exploited.' : '';
  const capNote = c && c.exploited !== null && c.exploited > c.findings.filter((f) => f.kev).length ? ` The list shows ${plural(c.findings.length, 'finding')}. The run found ${c.exploited} exploited in all, so the list is capped.` : '';
  blocks.push(readout(`${b ? `Read ${plural(b.guests.length, 'backup record')}, ${ageText(b.checkedAt, now)}.` : 'The feed carried no backup report.'} ${c ? `Read ${c.packages} package versions on ${plural(c.hosts, 'host')} against ${plural(c.advisories, 'advisory', 'advisories')}, ${ageText(c.checkedAt, now)}.${c.notChecked.length ? ` Not checked: ${c.notChecked.join(', ')}.` : ''}${gaps}${kevNote}${capNote}` : 'The CVE report was not read.'} ${notRead}`));
  return blocks;
}
export const healthView = (d: DashboardData, now: number): string => healthBlocks(d, now).join('');

// ---- Services: can I fail over? ----

const HEALTH_WORD: Record<Health, string> = { ok: 'healthy', down: 'down', unknown: 'unknown' };

/** One service's card for the switch panel, with the facts the page needs to wire it. */
export function serviceCard(s: ServiceRow, now: number, canRequest: boolean, id: string): { html: string; to: 'lab' | 'cloud'; can: boolean } {
  const sw = switchState(s, now);
  const can = sw.allowed && canRequest;
  const reason = !canRequest && sw.allowed ? 'Read-only feed: no switch from here.' : sw.reason;
  const html = switchCard({ id, name: s.name, active: s.active, dataClass: s.dataClass, pinned: s.pinned, labState: healthOf(s.lab, now), cloudState: healthOf(s.cloud, now), canSwitch: can, reason, labels: { lab: 'Lab', cloud: 'Cloud' } });
  return { html, to: sw.to, can };
}

/** The answer for the Services tab. A switch needs a fresh, healthy target, so an unknown target is an unknown answer, never a yes. */
export function servicesVerdict(d: DashboardData, now: number): string {
  const dropped = d.droppedServices > 0 ? ` ${plural(d.droppedServices, 'service row was', 'service rows were')} unreadable and ${d.droppedServices === 1 ? 'is' : 'are'} not counted.` : '';
  if (d.services.length === 0) return verdict({ state: 'unknown', title: 'No service was read', body: `So it is unknown whether anything can fail over.${dropped}` });
  const movable = d.services.filter((s) => !s.pinned);
  const pinned = d.services.length - movable.length;
  const states = movable.map((s) => ({ s, sw: switchState(s, now), serving: healthOf(s.active === 'lab' ? s.lab : s.cloud, now) }));
  const ready = states.filter((x) => x.sw.allowed);
  const blocked = states.filter((x) => !x.sw.allowed);
  const servingDown = states.filter((x) => x.serving === 'down');
  const pin = pinned ? ` ${plural(pinned, 'service is', 'services are')} pinned in the Lab and ${pinned === 1 ? 'does' : 'do'} not move.` : '';
  const why = blocked.length ? ` Blocked: ${blocked.map((x) => `${x.s.name} (${x.sw.reason.replace(/\.$/, '').replace(/\. .*$/, '')})`).join('; ')}.` : '';
  if (servingDown.length) {
    const canMove = servingDown.filter((x) => x.sw.allowed).map((x) => x.s.name);
    return verdict({ state: 'down', title: `${plural(servingDown.length, 'service is', 'services are')} down on the side that serves`, body: `${servingDown.map((x) => x.s.name).join(', ')}. ${canMove.length ? `Can move now: ${canMove.join(', ')}.` : 'None of them can move now.'}${why}${dropped}` });
  }
  if (movable.length === 0) return verdict({ state: 'ok', stateText: 'Nothing to move', title: 'Every service is pinned in the Lab', body: `No service is set up to fail over.${dropped}` });
  if (blocked.length === 0 && !dropped) return verdict({ state: 'ok', stateText: 'Ready', title: `Yes: ${movable.length === 1 ? 'the one movable service' : `all ${movable.length} movable services`} can switch`, body: `Each target side is fresh and healthy.${pin}` });
  const anyUnknown = blocked.some((x) => healthOf(x.sw.to === 'cloud' ? x.s.cloud : x.s.lab, now) === 'unknown') || !!dropped;
  if (ready.length === 0) return verdict({ state: anyUnknown ? 'unknown' : 'down', stateText: anyUnknown ? undefined : 'Not ready', title: 'No service can switch now', body: `${why.trim()}${pin}${dropped}` });
  return verdict({ state: anyUnknown ? 'unknown' : 'warn', stateText: 'Partly', title: `${ready.length} of ${plural(movable.length, 'movable service')} can switch now`, body: `Ready: ${ready.map((x) => x.s.name).join(', ')}.${why}${pin}${dropped}` });
}

export function watchdogMeters(d: DashboardData, now: number): string {
  const checks = d.services.flatMap((s) => [healthOf(s.lab, now), healthOf(s.cloud, now)]);
  const count = (h: Health): number => checks.filter((x) => x === h).length;
  const partial = d.droppedServices > 0 ? ` (${d.droppedServices} service row${d.droppedServices === 1 ? '' : 's'} unreadable, not counted)` : '';
  const m = (h: Health, tone: 'green' | 'red' | 'yellow') => meter({ label: `Probes ${HEALTH_WORD[h]}`, value: count(h), max: Math.max(1, checks.length), tone, valueText: `${count(h)} of ${checks.length}`, id: `m-${h}` });
  return meters([m('ok', 'green'), m('down', 'red'), m('unknown', 'yellow')], { label: `Watchdog summary${partial}` });
}

export function servicesReadout(d: DashboardData, now: number): string {
  return readout(`Read ${plural(d.services.length, 'service')}, ${ageText(d.generatedAt, now)}. Each side is checked by its own watchdog, and a missing or stale record shows as unknown.`);
}

/** One strip per service that has history. A service with none says so, never an empty strip that reads as healthy. */
export function uptimeStrips(d: DashboardData): string {
  const h = d.history;
  if (!h) return `<div class="toon-empty">${p('The uptime history was not read, so there are no strips.')}</div>`;
  if (d.services.length === 0) return `<div class="toon-empty">${p('No service was read, so there are no strips.')}</div>`;
  return `<div class="dash-stack">${d.services.map((s) => {
    const cells = h.uptime[s.name];
    return cells?.length ? card(uptime({ label: `${s.name} uptime`, windowLabel: `last ${cells.length} readings`, cells })) : `<div class="toon-empty">${p(`${s.name}: no uptime history was read.`)}</div>`;
  }).join('')}</div>`;
}

/** The record under the switch panel: drills, uptime and the watchdog count, each closed until asked for. */
export function servicesRecord(d: DashboardData, now: number): string {
  const drills = d.history?.drills ?? [];
  const ran = drills.filter((x) => x.result !== 'not injected').length;
  return list([
    disclosure({ id: 'svc-drills', lead: 'DRILL', title: 'Drill history', sub: 'Practice failovers: how long detection, the flip and recovery took.', note: d.history ? `${ran} run` : 'not read', native: true, panel: drillChart(d) }),
    disclosure({ id: 'svc-uptime', lead: 'UPTIME', title: 'Uptime per service', sub: 'A strip of recent probe readings for each service.', note: `${d.services.length} ${d.services.length === 1 ? 'service' : 'services'}`, native: true, panel: uptimeStrips(d) }),
    disclosure({ id: 'svc-watchdog', lead: 'PROBE', title: 'Watchdog readings', sub: 'How many probes read healthy, down and unknown.', note: `${d.services.length * 2} probes`, native: true, panel: card(watchdogMeters(d, now)) }),
  ], { label: 'Drills, uptime and watchdog readings' });
}

// ---- Work: what is waiting on me, and what is stuck? ----

/** The week's shipped PRs, as one tap-to-open record under Work. Empty when the feed carried no weekly report. */
function shippedBlocks(d: DashboardData, now: number, num: string): string[] {
  const w = d.shipped;
  if (!w) return [];
  const prs = w.prs.length ? list(w.prs.map((x) => row({ lead: `${x.repo} #${x.number}`, title: x.title, aside: x.author })), { label: 'Newest merged pull requests' }) : p('No merged pull request is listed.');
  const repos = w.repos.length ? list(w.repos.map((x) => row({ lead: String(x.count), title: x.repo })), { label: 'Merged pull requests per repository' }) : '';
  const cover = `Read ${w.reposRead} of ${w.reposTotal} repositories${w.unread.length ? `. Not read: ${w.unread.join(', ')}` : ''}.`;
  const panel = (w.summary ? p(w.summary) : '') + prs + repos + readout(`Week of ${w.week}, written ${ageText(w.generatedAt, now)}. ${cover} ${w.capped.length ? `At least this many: the read of ${w.capped.join(', ')} stopped inside the week. ` : ''}The list shows the newest ${w.prs.length} of ${w.total}. ${w.openNow} still open.`);
  return [section(num, 'Shipped this week', list([disclosure({ id: 'work-shipped', lead: 'PR', title: `${w.capped.length ? 'At least ' : ''}${plural(w.total, 'pull request')} merged`, note: `week of ${w.week}`, native: true, panel })], { label: 'The week\'s merged pull requests' }))];
}

export function workBlocks(d: DashboardData, now: number): string[] {
  const out = workCore(d, now);
  const extra = shippedBlocks(d, now, String(out.filter((b) => b.includes('dash-section')).length + 1).padStart(2, '0'));
  if (!extra.length) return out;
  // Keep the closing readout last.
  const last = out.length - 1;
  return [...out.slice(0, last), ...extra, out[last]!];
}

function workCore(d: DashboardData, now: number): string[] {
  const pl = d.plane;
  const gap = 'Pending lab-write taps and pull requests that wait for your word are not in the feed yet.';
  if (!pl) return [verdict({ state: 'unknown', title: 'The Plane board was not read', body: 'So it is unknown what waits on you.' }), readout(`The Plane board was not read. ${gap}`)];
  const lost = pl.lost && pl.lost > 0 ? ` ${plural(pl.lost, 'item', 'items')} in the cycle could not be found on the board, so these counts are incomplete.` : '';
  const cyc = pl.cycle ? ` Current cycle: ${pl.cycle}.` : '';
  const det = pl.detail;
  const mine = det ? det.items.filter((i) => i.needsPedro) : [];
  const answer = !planeFresh(d, now)
    ? verdict({ state: 'unknown', title: 'The Plane board read is out of date', body: `It was last read ${ageText(pl.checkedAt, now)}. It showed ${pl.open} open and ${pl.needsPedro} waiting on you.` })
    : lost
    ? verdict({ state: 'unknown', title: 'The board counts are incomplete', body: `${lost.trim()} The read shows ${pl.open} open and ${pl.needsPedro} waiting on you.` })
    : pl.needsPedro > 0
    ? verdict({ state: 'warn', stateText: 'Waiting on you', title: `${plural(pl.needsPedro, 'item waits', 'items wait')} on you`, body: mine[0] ? `Start with PET-${mine[0].seq}: ${mine[0].name}.` : 'The feed carried no item list, so open Plane for their names.' })
    : verdict({ state: 'ok', stateText: 'Unblocked', title: 'Nothing waits on you', body: `${pl.open} open in all, ${pl.inReview} in review.` });
  const figures = strip(
    [{ value: String(pl.open), label: 'open' }, ...(det && det.inProgress !== null ? [{ value: String(det.inProgress), label: 'in progress' }] : []), { value: String(pl.inReview), label: 'in review', accent: 'violet' as const }, { value: String(pl.needsPedro), label: 'need Pedro', accent: 'red' as const }],
    { label: 'Open items by state' },
  );
  const read = (extra = ''): string => readout(`Read the PET board from the mirror, ${ageText(pl.checkedAt, now)}.${cyc}${lost}${extra} Need Pedro means the needs-pedro label. ${gap}`);
  if (!det) return [answer, section('01', 'On record', list([disclosure({ id: 'work-counts', lead: 'OPEN', title: 'Open counts', sub: 'Open, in progress, in review and waiting on you.', note: `${pl.open} open`, native: true, panel: figures })], { label: 'Board counts' })), read(' The feed carried no cycle detail, so there is no item list.')];
  const end = Date.parse(`${det.end}T23:59:59Z`);
  const left = Number.isFinite(end) ? Math.ceil((end - now) / 86_400_000) : null;
  const when = left === null ? 'The cycle has no readable end date.' : left > 0 ? `${plural(left, 'day')} left, to ${det.end}.` : left === 0 ? `The cycle ends today, ${det.end}.` : `The cycle ended on ${det.end}.`;
  const progress = card(
    meters(
      [
        meter({ label: 'Cycle done', value: det.done, max: Math.max(1, det.total), tone: 'green', size: 'lg', valueText: `${det.done} of ${det.total}`, id: 'pl-done' }),
        ...det.routes.filter((r) => r.total > 0).map((r) => meter({ label: r.name, value: r.done, max: r.total, tone: r.name === 'Pedro' ? 'red' : r.name === 'Claude' ? 'violet' : 'mist', valueText: `${r.done} of ${r.total}`, sub: r.name === 'Pedro' ? 'items that need you' : r.name === 'Claude' ? 'items a cloud thread does' : 'items with neither label', id: `pl-${r.name.toLowerCase()}` })),
      ],
      { label: 'Cycle progress, done of total' },
    ) + readout(when, { onPaper: true, label: 'Time' }),
  );
  const itemRow = (i: (typeof det.items)[number]): string => row({ lead: `PET-${i.seq}`, title: i.name, sub: i.needsPedro ? 'Carries the needs-pedro label.' : 'No needs-pedro label.', aside: i.state, dot: i.needsPedro ? 'red' : undefined });
  const others = det.items.filter((i) => !i.needsPedro);
  const shown = det.items.length < pl.open ? ` The lists show ${det.items.length} of ${pl.open} open items.` : '';
  const record = [
    disclosure({ id: 'work-cycle', lead: 'CYCLE', title: pl.cycle || 'Cycle', sub: 'Items done against the cycle total, and who owns the rest.', note: `${det.done} of ${det.total} done`, native: true, panel: progress + figures }),
    ...(others.length ? [disclosure({ id: 'work-open', lead: 'OPEN', title: 'Also open, not waiting on you', sub: 'Open items with no needs-pedro label.', note: `${others.length} open`, native: true, panel: list(others.map(itemRow), { label: 'Other open items' }) })] : []),
  ];
  return [
    answer,
    ...(mine.length ? [section('01', 'Waiting on you', list(mine.map(itemRow), { label: 'Items that wait on you' }))] : []),
    section(mine.length ? '02' : '01', 'On record', list(record, { label: 'The cycle and the other open items' })),
    read(shown),
  ];
}
export const workView = (d: DashboardData, now: number): string => workBlocks(d, now).join('');

// ---- Charts. Each is the kit's `bars()` with a key that names every tone in words and a table with the same numbers. ----

type BarsOpts = Parameters<typeof bars>[0];
type Key = Parameters<typeof barsKey>[0];

/**
 * The kit's `bars()` throws when every column is empty. A chart that cannot be drawn must never take the page down,
 * so an all-zero or failing chart says so and leaves the table, which always carries the numbers.
 */
function drawBars(opts: BarsOpts, key: Key): string {
  const total = opts.columns.reduce((a, c) => a + c.segments.reduce((b, seg) => b + seg.value, 0), 0);
  if (total <= 0) return p('Every value is zero, so there is no bar to draw. The table has the numbers.');
  try {
    return bars(opts) + barsKey(key);
  } catch {
    return p('The chart could not be drawn. The table has the numbers.');
  }
}

const empty = (text: string): string => `<div class="toon-empty">${p(text)}</div>`;
const shortDay = (d: string): string => d.slice(5);
const note = (text: string): string => readout(text, { onPaper: true, label: 'Read' });

export function alertVolumeChart(d: DashboardData): string {
  const h = d.history;
  if (!h) return empty('The alert history was not read, so there is no chart.');
  if (h.alerts.length === 0) return empty('Read 0 days of alert history.');
  const total = h.alerts.reduce((a, x) => a + x.act + x.noAction + x.unreadable, 0);
  const chart = drawBars(
    { label: 'Alerts per day', columns: h.alerts.map((x) => ({ label: shortDay(x.day), segments: [{ value: x.act, tone: 'red', label: 'needs you' }, { value: x.noAction, tone: 'mist', label: 'no action' }, { value: x.unreadable, tone: 'hatch', label: 'unreadable' }] })) },
    [{ label: 'Needs you', tone: 'red' }, { label: 'No action', tone: 'mist' }, { label: 'Triage unreadable', tone: 'hatch' }],
  );
  return card(chart + chartTable({ caption: 'alerts per day', head: ['Day', 'Needs you', 'No action', 'Unreadable'], rows: h.alerts.map((x) => [x.day, String(x.act), String(x.noAction), String(x.unreadable)]) }) + note(`${plural(h.alerts.length, 'day')} and ${plural(total, 'alert')}.`));
}

export function cveHistoryChart(d: DashboardData): string {
  const h = d.history;
  if (!h) return empty('The CVE history was not read, so there is no chart.');
  if (h.cve.length === 0) return empty('Read 0 days of CVE history.');
  const chart = drawBars(
    { label: 'Open CVE findings with a fix, per day', columns: h.cve.map((x) => ({ label: shortDay(x.day), segments: [{ value: x.critical, tone: 'red', label: 'critical' }, { value: x.high, tone: 'yellow', label: 'high' }, { value: x.medium, tone: 'violet', label: 'medium' }, { value: x.low, tone: 'hatch', label: 'low' }] })) },
    [{ label: 'Critical', tone: 'red' }, { label: 'High', tone: 'yellow' }, { label: 'Medium', tone: 'violet' }, { label: 'Low', tone: 'hatch' }],
  );
  return card(chart + chartTable({ caption: 'CVE findings per day', head: ['Day', 'Critical', 'High', 'Medium', 'Low'], rows: h.cve.map((x) => [x.day, String(x.critical), String(x.high), String(x.medium), String(x.low)]) }) + note(`${plural(h.cve.length, 'day')} of CVE counts.`));
}

export function drillChart(d: DashboardData): string {
  const h = d.history;
  if (!h) return empty('The drill history was not read, so there is no chart.');
  if (h.drills.length === 0) return empty('Read 0 failover drills. None has run yet.');
  const ran = h.drills.filter((x) => x.result !== 'not injected');
  const chart = ran.length
    ? drawBars(
        { label: 'Failover drill time in seconds', columns: ran.map((x) => ({ label: x.label, sub: x.result, segments: [{ value: x.detectS, tone: 'yellow', label: 'detect' }, { value: x.flipS, tone: 'violet', label: 'flip' }, { value: x.clientS, tone: 'red', label: 'client recovers' }] })) },
        [{ label: 'Detect', tone: 'yellow' }, { label: 'Flip', tone: 'violet' }, { label: 'Client recovers', tone: 'red' }],
      )
    : '';
  const skipped = h.drills.length - ran.length;
  return card(
    chart +
      chartTable({ caption: 'failover drills', head: ['Drill', 'Result', 'Detect (s)', 'Flip (s)', 'Client recovers (s)'], rows: h.drills.map((x) => [x.label, x.result, String(x.detectS), String(x.flipS), String(x.clientS)]) }) +
      note(`${plural(h.drills.length, 'drill')}. ${ran.length} injected ${ran.length === 1 ? 'its' : 'their'} fault and ${skipped} did not, which counts as not run, never as passed.`),
  );
}

export { section };
