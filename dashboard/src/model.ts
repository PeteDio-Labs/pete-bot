/**
 * The dashboard's data model and the one place that decides what "unknown" means.
 *
 * ⚠ A READ THAT FAILED IS `unknown`, NEVER `ok`. A watchdog record that is missing, malformed
 * or older than STALE_MS shows as unknown, so a dead probe cannot read as a healthy service.
 * Every view says what it examined (counts and the time of the read), so "0 findings after
 * reading 412 packages" and "0 findings because nothing was read" do not look alike.
 */
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
  /** True for services that must stay on-prem (Plex, the arr stack, qBittorrent). */
  pinned: boolean;
  auto: boolean;
  lab: SideStatus | null;
  cloud: SideStatus | null;
}

export interface DayAlerts { day: string; act: number; noAction: number; unreadable: number }
export interface DayCve { day: string; critical: number; high: number; medium: number; low: number }
export interface Drill { label: string; detectS: number; flipS: number; clientS: number; result: 'passed' | 'failed' | 'not injected' }

export interface UptimeCell { at: string; state: 'ok' | 'down' | 'unknown'; detail?: string }

export interface DashboardData {
  history: { alerts: DayAlerts[]; cve: DayCve[]; drills: Drill[]; uptime: Record<string, UptimeCell[]> } | null;
  generatedAt: string;
  source: string;
  triage: { read: number; cards: number; plain: number; failures: number; since: string } | null;
  needs: Needs[];
  alerts: AlertRow[];
  cve: { checkedAt: string; hosts: number; packages: number; advisories: number; notChecked: string[]; findings: CveFinding[]; /** The run's full exploited count. `findings` may be capped, so the tile uses this when present. */ exploited: number | null; /** What the run could not examine. Empty means the run says it examined everything. */ gaps: string[]; /** False when the exploited-vulnerability list was not read, so no finding carries a KEV flag and a zero means nothing. */ kevChecked: boolean } | null;
  services: ServiceRow[];
  /** `cycle` names the current cycle. `lost` counts cycle items missing from the board read, so the counts cover fewer items than the cycle holds. */
  plane: { checkedAt: string; open: number; needsPedro: number; inReview: number; cycle: string; lost: number | null } | null;
  /** Live sections the feed did not carry or carried stale. Their tiles read `unknown`, never a zero. */
  unread: ('needs' | 'alerts')[];
  /** Service rows the parser dropped. Probe totals then cover fewer services than the feed listed. */
  droppedServices: number;
}

export interface Examined {
  /** What the view read, in words that include a count. */
  text: string;
}

export function healthOf(s: SideStatus | null, now: number): Health {
  if (!s) return 'unknown';
  const at = Date.parse(s.checkedAt);
  if (!Number.isFinite(at) || now - at > STALE_MS) return 'unknown';
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
  if (s.pinned) return { to, allowed: false, reason: 'Pinned on-prem. This service does not move.' };
  const target = healthOf(to === 'cloud' ? s.cloud : s.lab, now);
  if (target !== 'ok') return { to, allowed: false, reason: `The ${to === 'cloud' ? 'cloud' : 'on-prem'} side is ${target}. A switch needs it healthy first.` };
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
const str = (v: unknown, n = 300): string => (typeof v === 'string' ? v.slice(0, n) : '');
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
  const unread = new Set<'needs' | 'alerts'>((['needs', 'alerts'] as const).filter((k) => !Array.isArray(o[k])));
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
  const tr = o.triage;
  const trNums = isObj(tr) ? [num(tr.read), num(tr.cards), num(tr.plain), num(tr.failures)] : [];
  const triage = isObj(tr) && trNums.every((v) => v !== null) ? { read: trNums[0]!, cards: trNums[1]!, plain: trNums[2]!, failures: trNums[3]!, since: str(tr.since, 40) } : null;
  if (!triage) problems.push(isObj(tr) ? 'the triage ledger had an unreadable counter' : 'the triage ledger is missing');
  const pl = o.plane;
  const plNums = isObj(pl) ? [num(pl.open), num(pl.needsPedro), num(pl.inReview)] : [];
  const plane = isObj(pl) && str(pl.checkedAt) && plNums.every((v) => v !== null) ? { checkedAt: str(pl.checkedAt, 40), open: plNums[0]!, needsPedro: plNums[1]!, inReview: plNums[2]!, cycle: str(pl.cycle, 60), lost: num(pl.lost) } : null;
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
  return { data: { history, generatedAt: str(o.generatedAt, 40), source: str(o.source, 40) || 'unknown', triage, needs, alerts, cve, services, plane, unread: [...unread], droppedServices: droppedServices + (num(o.droppedServices) ?? 0) }, problems };
}
