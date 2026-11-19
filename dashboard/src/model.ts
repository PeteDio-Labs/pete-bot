/**
 * The dashboard's data model and the one place that decides what "unknown" means.
 *
 * ⚠ A READ THAT FAILED IS `unknown`, NEVER `ok`. A watchdog record that is missing, malformed
 * or older than STALE_MS shows as unknown, so a dead probe cannot read as a healthy service.
 * Every view says what it examined (counts and the time of the read), so "0 findings after
 * reading 412 packages" and "0 findings because nothing was read" do not look alike.
 */
import type { KeyList } from './keys.ts';
export type Side = 'lab' | 'cloud';
export type Health = 'ok' | 'down' | 'unknown';
export type Severity = 'critical' | 'high' | 'medium' | 'low';

export const STALE_MS = 5 * 60_000;

export interface Needs {
  id: string;
  title: string;
  why: string;
  step: string;
  since: string;
}

export interface AlertRow {
  monitor: string;
  state: 'down' | 'up';
  since: string;
  triage: 'act' | 'no_action' | 'unreadable' | 'off';
  step?: string;
  why?: string;
}

export interface CveFinding {
  id: string;
  pkg: string;
  host: string;
  severity: Severity;
  fixed: string | null;
  kev: boolean;
}

export interface SiteRow { name: string; env: 'production' | 'staging'; url: string; reading: SideStatus | null }

export interface SideStatus {
  ok: boolean;
  checkedAt: string;
  detail: string;
  lagS: number | null;
}

export interface ServiceRow {
  name: string;
  hostname: string;
  active: Side;
  dataClass: 'stateless' | 'replicated' | 'snapshot';
  /** True for services that must stay in the Lab (Plex, the arr stack, qBittorrent). */
  pinned: boolean;
  auto: boolean;
  lab: SideStatus | null;
  cloud: SideStatus | null;
}

export interface DayAlerts { day: string; act: number; noAction: number; unreadable: number }
export interface DayCve { day: string; critical: number; high: number; medium: number; low: number }
export interface Drill { label: string; detectS: number; flipS: number; clientS: number; result: 'passed' | 'failed' | 'not injected' }

export interface UptimeCell { at: string; state: 'ok' | 'down' | 'unknown'; detail?: string }

export interface PlaneItemRow { seq: number; name: string; state: string; needsPedro: boolean }
export interface PlaneDetail {
  total: number;
  done: number;
  /** Null when the feed did not carry it. */
  inProgress: number | null;
  start: string;
  end: string;
  /** Who each cycle item waits on: Pedro, a cloud thread, or neither label. */
  routes: { name: 'Pedro' | 'Claude' | 'Unlabelled'; total: number; done: number }[];
  /** Open items, capped by the producer. `open` is the full count. */
  items: PlaneItemRow[];
}

/** One guest's backup record. `lastGood` is null when no good run is on record. */
export interface BackupRow { guest: string; lastGood: string | null; detail: string }
/** A backup is nightly: late after 36 hours, and wrong after 72 hours or with no good run on record. */
export const BACKUP_LATE_MS = 36 * 3_600_000;
export const BACKUP_DOWN_MS = 72 * 3_600_000;
export function backupState(b: BackupRow, now: number): 'ok' | 'warn' | 'down' {
  const age = b.lastGood ? now - Date.parse(b.lastGood) : Number.NaN;
  if (!isFresh(age, BACKUP_DOWN_MS)) return 'down';
  return age > BACKUP_LATE_MS ? 'warn' : 'ok';
}

/** The staging box's 24-hour clock. Null when the feed carried none, which draws nothing. */
export type StagingClock =
  | { state: 'up'; uptimeSec: number; shutsDownInSec: number; checkedAt: string }
  | { state: 'limit' | 'stopped' | 'unknown'; checkedAt: string; detail: string };

export interface DashboardData {
  /** The staging clock. Null when the feed carried none or it did not parse. */
  staging: StagingClock | null;
  /** The last good backup per guest. Null when the feed carried no backup report or it did not parse. */
  backups: { checkedAt: string; guests: BackupRow[] } | null;
  history: { alerts: DayAlerts[]; cve: DayCve[]; drills: Drill[]; uptime: Record<string, UptimeCell[]> } | null;
  generatedAt: string;
  source: string;
  triage: { read: number; cards: number; plain: number; failures: number; since: string } | null;
  needs: Needs[];
  alerts: AlertRow[];
  cve: { checkedAt: string; hosts: number; packages: number; advisories: number; notChecked: string[]; findings: CveFinding[]; /** The run's full exploited count. `findings` may be capped, so the tile uses this when present. */ exploited: number | null; /** What the run could not examine. Empty means the run says it examined everything. */ gaps: string[]; /** False when the exploited-vulnerability list was not read, so no finding carries a KEV flag and a zero means nothing. */ kevChecked: boolean } | null;
  services: ServiceRow[];
  /** Public sites the lab does not run. A reading of null is unknown, never up. */
  sites: SiteRow[];
  /** `cycle` names the current cycle. `lost` counts cycle items missing from the board read, so the counts cover fewer items than the cycle holds. */
  plane: { checkedAt: string; open: number; needsPedro: number; inReview: number; cycle: string; lost: number | null; /** The cycle's progress, split and open items. Null when the feed carried none or a part of it did not parse: the view then shows the counts alone. */ detail: PlaneDetail | null } | null;
  /** The last key list the lab read, with when it read it. Null when the feed carried none or it did not parse. Names, owners and dates only. */
  keys: { list: KeyList; at: number } | null;
  /** The newest weekly PR report. Null when the feed carried none or it did not parse. */
  shipped: { week: string; generatedAt: string; total: number; openNow: number; reposRead: number; reposTotal: number; unread: string[]; /** Repos whose read stopped inside the week: the total is then a lower bound. */ capped: string[]; repos: { repo: string; count: number }[]; prs: { repo: string; number: number; title: string; author: string }[]; summary: string } | null;
  /** Live sections the feed did not carry or carried stale. Their tiles read `unknown`, never a zero. */
  unread: ('needs' | 'alerts' | 'backups')[];
  /** Service rows the parser dropped. Probe totals then cover fewer services than the feed listed. */
  droppedServices: number;
}

export interface Examined {
  /** What the view read, in words that include a count. */
  text: string;
}

/**
 * The clock a view reads ages against. The fixture is a recording, so it is read one minute after it was written: staging
 * then shows the page as designed, not a page of stale records. The page says so in a banner. A feed with any other
 * source is read against the real clock, so a dead watchdog still ages into `unknown`. So is a feed from any address
 * but the fixture file that ships with the page: a live feed cannot claim the demo clock by naming itself `fixture`.
 */
export const DEMO_SOURCE = 'fixture';
export function clockFor(d: Pick<DashboardData, 'source' | 'generatedAt'>, now: number, shippedFixture: boolean): number {
  if (!shippedFixture || d.source !== DEMO_SOURCE) return now;
  const at = Date.parse(d.generatedAt);
  return Number.isFinite(at) ? at + 60_000 : now;
}

/** A time more than five minutes ahead of the clock is not a reading of now, so it is not fresh either. */
export const SKEW_MS = 5 * 60_000;
export const isFresh = (age: number, maxMs: number): boolean => Number.isFinite(age) && age <= maxMs && age >= -SKEW_MS;

export function healthOf(s: SideStatus | null, now: number): Health {
  if (!s) return 'unknown';
  const at = Date.parse(s.checkedAt);
  if (!isFresh(now - at, STALE_MS)) return 'unknown';
  return s.ok ? 'ok' : 'down';
}

export function ageText(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'at an unknown time';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
}

/** Whether the switch for a service may be requested, and the reason it may not. */
export function switchState(s: ServiceRow, now: number): { to: Side; allowed: boolean; reason: string } {
  const to: Side = s.active === 'lab' ? 'cloud' : 'lab';
  if (s.pinned) return { to, allowed: false, reason: 'Pinned in the Lab. This service does not move.' };
  const target = healthOf(to === 'cloud' ? s.cloud : s.lab, now);
  if (target !== 'ok') return { to, allowed: false, reason: `The ${to === 'cloud' ? 'cloud' : 'Lab'} side is ${target}. A switch needs it healthy first.` };
  if (s.dataClass === 'replicated') {
    const lag = (to === 'cloud' ? s.cloud : s.lab)?.lagS;
    if (lag === null || lag === undefined) return { to, allowed: false, reason: 'Replication lag is unknown, so the switch could lose data.' };
  }
  return { to, allowed: true, reason: s.auto ? 'May switch on its own.' : 'Waits for your tap on lab-write.' };
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

export function sortFindings(f: CveFinding[]): CveFinding[] {
  return [...f].sort((a, b) => Number(b.kev) - Number(a.kev) || SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.pkg.localeCompare(b.pkg));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Trimmed, so a string of spaces is no string: the kit refuses an empty title, and a blank name names nothing. */
const str = (v: unknown, n = 300): string => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function side(v: unknown): SideStatus | null {
  if (!isObj(v) || typeof v.ok !== 'boolean' || !str(v.checkedAt)) return null;
  return { ok: v.ok, checkedAt: str(v.checkedAt, 40), detail: str(v.detail, 200), lagS: num(v.lagS) };
}

/** Per-service strips. A bad state becomes `unknown`, never ok, and a strip keeps at most the newest 150 cells. */
function parseUptime(v: unknown): Record<string, UptimeCell[]> {
  const out: Record<string, UptimeCell[]> = {};
  if (!isObj(v)) return out;
  for (const [name, cells] of Object.entries(v).slice(0, 40)) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name) || !Array.isArray(cells)) continue;
    const ok = cells
      .filter((c) => isObj(c) && Number.isFinite(Date.parse(str(c.at, 40))))
      .map((c) => {
        const r = c as Record<string, unknown>;
        const state = r.state === 'ok' || r.state === 'down' ? r.state : 'unknown';
        return { at: str(r.at, 40), state, ...(str(r.detail, 80) ? { detail: str(r.detail, 80) } : {}) } as UptimeCell;
      });
    if (ok.length) out[name] = ok.slice(-150);
  }
  return out;
}

/**
 * The cycle detail. It is optional, so a feed without it is not a problem. A detail that is present but has a bad
 * counter or a bad item is dropped whole and reported: half a progress bar would read as a real one.
 */
function planeDetail(pl: Record<string, unknown>, problems: string[]): PlaneDetail | null {
  if (pl.total === undefined && pl.done === undefined) return null;
  const total = num(pl.total);
  const done = num(pl.done);
  const bad = (): null => {
    problems.push('the Plane cycle detail was unreadable, so only the counts are shown');
    return null;
  };
  if (total === null || done === null || total < 0 || done < 0 || done > total) return bad();
  const routes: PlaneDetail['routes'] = [];
  const by = isObj(pl.byRoute) ? pl.byRoute : {};
  for (const [key, name] of [['pedro', 'Pedro'], ['ai', 'Claude'], ['other', 'Unlabelled']] as const) {
    const r = by[key];
    if (r === undefined) continue;
    if (!isObj(r) || num(r.total) === null || num(r.done) === null || num(r.done)! < 0 || num(r.done)! > num(r.total)!) return bad();
    routes.push({ name, total: num(r.total)!, done: num(r.done)! });
  }
  const items: PlaneItemRow[] = [];
  for (const it of Array.isArray(pl.openItems) ? pl.openItems.slice(0, 30) : []) {
    if (!isObj(it) || num(it.seq) === null || !str(it.name)) return bad();
    items.push({ seq: num(it.seq)!, name: str(it.name, 120), state: str(it.state, 40) || 'unknown state', needsPedro: Array.isArray(it.labels) && it.labels.includes('needs-pedro') });
  }
  return { total, done, inProgress: num(pl.inProgress), start: str(pl.start, 10), end: str(pl.end, 10), routes, items };
}

/**
 * Reads the feed's JSON. A section that does not parse is dropped and reported in `problems`,
 * never filled with a default that looks healthy.
 */
export function parseDashboard(raw: unknown): { data: DashboardData; problems: string[] } {
  const problems: string[] = [];
  const o = isObj(raw) ? raw : {};
  if (!isObj(raw)) problems.push('the feed is not an object');
  const arr = (k: string): unknown[] => {
    const v = o[k];
    if (Array.isArray(v)) return v;
    problems.push(`${k} is missing or not a list`);
    return [];
  };
  const unread = new Set<'needs' | 'alerts' | 'backups'>((['needs', 'alerts'] as const).filter((k) => !Array.isArray(o[k])));
  const needs: Needs[] = [];
  for (const n of arr('needs')) if (isObj(n) && str(n.id) && str(n.title) && str(n.step)) needs.push({ id: str(n.id, 80), title: str(n.title, 160), why: str(n.why), step: str(n.step), since: str(n.since, 40) });
  else {
    problems.push('a needs row was unreadable');
    unread.add('needs');
  }
  const alerts: AlertRow[] = [];
  for (const a of arr('alerts')) {
    if (!isObj(a) || !str(a.monitor) || (a.state !== 'down' && a.state !== 'up')) {
      problems.push('an alert row was unreadable');
      unread.add('alerts');
      continue;
    }
    const t = a.triage;
    alerts.push({ monitor: str(a.monitor, 120), state: a.state, since: str(a.since, 40), triage: t === 'act' || t === 'no_action' || t === 'unreadable' ? t : 'off', step: str(a.step, 200) || undefined, why: str(a.why, 200) || undefined });
  }
  let cve: DashboardData['cve'] = null;
  if (isObj(o.cve) && str(o.cve.checkedAt) && Array.isArray(o.cve.findings)) {
    const findings: CveFinding[] = [];
    let droppedFinding = false;
    for (const f of o.cve.findings) {
      if (isObj(f) && str(f.id) && str(f.pkg) && SEVERITY_ORDER.includes(f.severity as Severity)) findings.push({ id: str(f.id, 60), pkg: str(f.pkg, 100), host: str(f.host, 80), severity: f.severity as Severity, fixed: str(f.fixed, 60) || null, kev: f.kev === true });
      else {
        problems.push('a CVE finding was unreadable');
        droppedFinding = true;
      }
    }
    cve = { checkedAt: str(o.cve.checkedAt, 40), hosts: num(o.cve.hosts) ?? 0, packages: num(o.cve.packages) ?? 0, advisories: num(o.cve.advisories) ?? 0, notChecked: Array.isArray(o.cve.notChecked) ? o.cve.notChecked.map((x) => str(x, 80)).filter(Boolean) : [], findings, exploited: num(o.cve.exploited) ?? null, gaps: [...(Array.isArray(o.cve.gaps) ? o.cve.gaps.map((x) => str(x, 200)).filter(Boolean) : []), ...(droppedFinding ? ['a finding could not be read, so the list may be missing an exploited one'] : []), ...(num(o.cve.hosts) === null || num(o.cve.packages) === null || num(o.cve.advisories) === null ? ['a coverage count was missing from the CVE report'] : [])], kevChecked: o.cve.kevChecked === true && !droppedFinding };
  } else problems.push('the CVE report is missing');
  const services: ServiceRow[] = [];
  let droppedServices = 0;
  for (const s of arr('services')) {
    if (!isObj(s) || !str(s.name) || (s.active !== 'lab' && s.active !== 'cloud') || !['stateless', 'replicated', 'snapshot'].includes(String(s.dataClass))) {
      problems.push('a service row was unreadable');
      droppedServices++;
      continue;
    }
    const dc = s.dataClass as ServiceRow['dataClass'];
    services.push({ name: str(s.name, 60), hostname: str(s.hostname, 120), active: s.active, dataClass: dc, pinned: s.pinned === true, auto: s.auto === true, lab: side(s.lab), cloud: side(s.cloud) });
  }
  const sites: SiteRow[] = [];
  for (const x of arr('sites')) {
    if (!isObj(x) || !str(x.name) || (x.env !== 'production' && x.env !== 'staging') || !/^https:\/\//.test(str(x.url, 200))) {
      problems.push('a site row was unreadable');
      continue;
    }
    sites.push({ name: str(x.name, 60), env: x.env, url: str(x.url, 200), reading: side(x.reading) });
  }
  const tr = o.triage;
  const trNums = isObj(tr) ? [num(tr.read), num(tr.cards), num(tr.plain), num(tr.failures)] : [];
  const triage = isObj(tr) && trNums.every((v) => v !== null) ? { read: trNums[0]!, cards: trNums[1]!, plain: trNums[2]!, failures: trNums[3]!, since: str(tr.since, 40) } : null;
  if (!triage) problems.push(isObj(tr) ? 'the triage ledger had an unreadable counter' : 'the triage ledger is missing');
  const pl = o.plane;
  const plNums = isObj(pl) ? [num(pl.open), num(pl.needsPedro), num(pl.inReview)] : [];
  const plane = isObj(pl) && str(pl.checkedAt) && plNums.every((v) => v !== null) ? { checkedAt: str(pl.checkedAt, 40), open: plNums[0]!, needsPedro: plNums[1]!, inReview: plNums[2]!, cycle: str(pl.cycle, 60), lost: num(pl.lost), detail: planeDetail(pl, problems) } : null;
  if (!plane) problems.push(isObj(pl) ? 'the Plane summary had an unreadable counter' : 'the Plane summary is missing');
  let history: DashboardData['history'] = null;
  const h = o.history;
  if (isObj(h) && Array.isArray(h.alerts) && Array.isArray(h.cve) && Array.isArray(h.drills)) {
    const n = (v: unknown): number => Math.max(0, num(v) ?? 0);
    const rowOk = (x: unknown, keys: string[]): boolean => isObj(x) && !!str(x.day) && keys.every((k) => num((x as Record<string, unknown>)[k]) !== null);
    const bad = h.alerts.some((x) => !rowOk(x, ['act', 'noAction', 'unreadable'])) || h.cve.some((x) => !rowOk(x, ['critical', 'high', 'medium', 'low']));
    if (bad) problems.push('the history had a row with an unreadable counter, so it is not shown');
    history = bad ? null : {
      alerts: h.alerts.filter((x) => isObj(x) && str(x.day)).map((x) => { const r = x as Record<string, unknown>; return { day: str(r.day, 10), act: n(r.act), noAction: n(r.noAction), unreadable: n(r.unreadable) }; }),
      cve: h.cve.filter((x) => isObj(x) && str(x.day)).map((x) => { const r = x as Record<string, unknown>; return { day: str(r.day, 10), critical: n(r.critical), high: n(r.high), medium: n(r.medium), low: n(r.low) }; }),
      uptime: parseUptime(h.uptime),
      drills: h.drills.filter((x) => isObj(x) && str(x.label)).map((x) => { const r = x as Record<string, unknown>; return { label: str(r.label, 40), detectS: n(r.detectS), flipS: n(r.flipS), clientS: n(r.clientS), result: r.result === 'passed' || r.result === 'failed' ? r.result : 'not injected' }; }),
    };
  } else problems.push('the history section is missing');
  let backups: DashboardData['backups'] = null;
  const bk = o.backups;
  if (bk !== undefined) {
    const rows = isObj(bk) && Array.isArray(bk.guests) ? bk.guests : null;
    if (!isObj(bk) || !str(bk.checkedAt) || !rows || rows.some((g) => !isObj(g) || !str(g.guest))) {
      problems.push('the backup report was unreadable');
      unread.add('backups');
    } else backups = { checkedAt: str(bk.checkedAt, 40), guests: rows.slice(0, 60).map((g) => { const r = g as Record<string, unknown>; return { guest: str(r.guest, 60), lastGood: str(r.lastGood, 40) || null, detail: str(r.detail, 160) }; }) };
  }
  let keysSec: DashboardData['keys'] = null;
  const ks = o.keys;
  if (ks !== undefined) {
    const at = isObj(ks) ? Date.parse(str(ks.at, 40)) : NaN;
    const rows = isObj(ks) && Array.isArray(ks.rows) ? ks.rows : null;
    const rowOk = (r: unknown): r is Record<string, unknown> => isObj(r) && /^[a-z][a-z0-9-]{1,30}$/.test(str(r.name)) && typeof r.hasToken === 'boolean' && typeof r.inCallers === 'boolean' && typeof r.expired === 'boolean' && typeof r.renewSoon === 'boolean';
    if (!isObj(ks) || !Number.isFinite(at) || !rows || rows.length === 0 || rows.length > 100 || !rows.every(rowOk)) problems.push('the key list was unreadable');
    else {
      keysSec = {
        at,
        list: {
          read: str(ks.read, 200),
          unparsed: Math.max(0, num(ks.unparsed) ?? 0),
          rows: rows.map((r) => { const x = r as Record<string, unknown>; return { name: str(x.name, 31), owner: str(x.owner, 60), hasToken: x.hasToken === true, version: str(x.version, 12) || null, expires: str(x.expires, 40) || null, daysLeft: num(x.daysLeft), expired: x.expired === true, renewSoon: x.renewSoon === true, inCallers: x.inCallers === true }; }),
        },
      };
    }
  }
  let staging: StagingClock | null = null;
  if (o.staging !== undefined) {
    const st = o.staging;
    const at = isObj(st) ? str(st.checkedAt, 40) : '';
    if (isObj(st) && st.state === 'up' && num(st.uptimeSec) !== null && num(st.shutsDownInSec) !== null && at) staging = { state: 'up', uptimeSec: num(st.uptimeSec)!, shutsDownInSec: num(st.shutsDownInSec)!, checkedAt: at };
    else if (isObj(st) && (st.state === 'limit' || st.state === 'stopped' || st.state === 'unknown') && at) staging = { state: st.state, checkedAt: at, detail: str(st.detail, 160) };
    else problems.push('the staging clock was unreadable');
  }
  let shipped: DashboardData['shipped'] = null;
  const sh = o.shipped;
  if (sh !== undefined) {
    const nums = isObj(sh) ? [num(sh.total), num(sh.openNow), num(sh.reposRead), num(sh.reposTotal)] : [];
    if (!isObj(sh) || !str(sh.week) || !str(sh.generatedAt) || nums.some((v) => v === null) || !Array.isArray(sh.repos) || !Array.isArray(sh.prs)) problems.push('the weekly PR report was unreadable');
    else {
      shipped = {
        week: str(sh.week, 10), generatedAt: str(sh.generatedAt, 40), total: nums[0]!, openNow: nums[1]!, reposRead: nums[2]!, reposTotal: nums[3]!,
        unread: (Array.isArray(sh.unread) ? sh.unread : []).map((x) => str(x, 60)).filter(Boolean).slice(0, 10),
        repos: sh.repos.filter((r) => isObj(r) && str(r.repo) && num(r.count) !== null).slice(0, 8).map((r) => ({ repo: str((r as Record<string, unknown>).repo, 60), count: num((r as Record<string, unknown>).count)! })),
        prs: sh.prs.filter((r) => isObj(r) && str(r.title) && num(r.number) !== null).slice(0, 10).map((r) => { const x = r as Record<string, unknown>; return { repo: str(x.repo, 60), number: num(x.number)!, title: str(x.title, 160), author: str(x.author, 40) }; }),
        capped: (Array.isArray(sh.capped) ? sh.capped : []).map((x) => str(x, 60)).filter(Boolean).slice(0, 10),
        summary: str(sh.summary, 800),
      };
    }
  }
  return { data: { staging, shipped, keys: keysSec, backups, history, generatedAt: str(o.generatedAt, 40), source: str(o.source, 40) || 'unknown', triage, needs, alerts, cve, services, sites, plane, unread: [...unread], droppedServices: droppedServices + (num(o.droppedServices) ?? 0) }, problems };
}
