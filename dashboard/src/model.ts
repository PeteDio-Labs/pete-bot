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

export interface DashboardData {
  generatedAt: string;
  source: string;
  triage: { read: number; cards: number; plain: number; failures: number; since: string } | null;
  needs: Needs[];
  alerts: AlertRow[];
  cve: { checkedAt: string; hosts: number; packages: number; advisories: number; notChecked: string[]; findings: CveFinding[] } | null;
  services: ServiceRow[];
  plane: { checkedAt: string; open: number; needsPedro: number; inReview: number } | null;
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
  const needs: Needs[] = [];
  for (const n of arr('needs')) if (isObj(n) && str(n.id) && str(n.title) && str(n.step)) needs.push({ id: str(n.id, 80), title: str(n.title, 160), why: str(n.why), step: str(n.step), since: str(n.since, 40) });
  else problems.push('a needs row was unreadable');
  const alerts: AlertRow[] = [];
  for (const a of arr('alerts')) {
    if (!isObj(a) || !str(a.monitor) || (a.state !== 'down' && a.state !== 'up')) {
      problems.push('an alert row was unreadable');
      continue;
    }
    const t = a.triage;
    alerts.push({ monitor: str(a.monitor, 120), state: a.state, since: str(a.since, 40), triage: t === 'act' || t === 'no_action' || t === 'unreadable' ? t : 'off', step: str(a.step, 200) || undefined, why: str(a.why, 200) || undefined });
  }
  let cve: DashboardData['cve'] = null;
  if (isObj(o.cve) && str(o.cve.checkedAt) && Array.isArray(o.cve.findings)) {
    const findings: CveFinding[] = [];
    for (const f of o.cve.findings) {
      if (isObj(f) && str(f.id) && str(f.pkg) && SEVERITY_ORDER.includes(f.severity as Severity)) findings.push({ id: str(f.id, 60), pkg: str(f.pkg, 100), host: str(f.host, 80), severity: f.severity as Severity, fixed: str(f.fixed, 60) || null, kev: f.kev === true });
      else problems.push('a CVE finding was unreadable');
    }
    cve = { checkedAt: str(o.cve.checkedAt, 40), hosts: num(o.cve.hosts) ?? 0, packages: num(o.cve.packages) ?? 0, advisories: num(o.cve.advisories) ?? 0, notChecked: Array.isArray(o.cve.notChecked) ? o.cve.notChecked.map((x) => str(x, 80)).filter(Boolean) : [], findings };
  } else problems.push('the CVE report is missing');
  const services: ServiceRow[] = [];
  for (const s of arr('services')) {
    if (!isObj(s) || !str(s.name) || (s.active !== 'lab' && s.active !== 'cloud')) {
      problems.push('a service row was unreadable');
      continue;
    }
    const dc = s.dataClass === 'replicated' || s.dataClass === 'snapshot' ? s.dataClass : 'stateless';
    services.push({ name: str(s.name, 60), hostname: str(s.hostname, 120), active: s.active, dataClass: dc, pinned: s.pinned === true, auto: s.auto === true, lab: side(s.lab), cloud: side(s.cloud) });
  }
  const tr = o.triage;
  const triage = isObj(tr) ? { read: num(tr.read) ?? 0, cards: num(tr.cards) ?? 0, plain: num(tr.plain) ?? 0, failures: num(tr.failures) ?? 0, since: str(tr.since, 40) } : null;
  if (!triage) problems.push('the triage ledger is missing');
  const pl = o.plane;
  const plane = isObj(pl) && str(pl.checkedAt) ? { checkedAt: str(pl.checkedAt, 40), open: num(pl.open) ?? 0, needsPedro: num(pl.needsPedro) ?? 0, inReview: num(pl.inReview) ?? 0 } : null;
  if (!plane) problems.push('the Plane summary is missing');
  return { data: { generatedAt: str(o.generatedAt, 40), source: str(o.source, 40) || 'unknown', triage, needs, alerts, cve, services, plane }, problems };
}
