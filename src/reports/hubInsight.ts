/**
 * The insight record (PET-868 follow-up): what the stored numbers mean. One record per local day,
 * rebuilt every few hours, that turns the GitHub, Plane, Kuma and CVE reads into a ranked "so what",
 * the items that need Pedro, what is stuck and aging, trends against last week and the 8-week
 * average, and what broke.
 *
 * ⚠ A record says what it read. Every source carries `ok` and a count. A source that could not be
 * read adds a gap and is never counted as zero, so "0 stuck PRs" after reading 41 PRs and "0 stuck
 * PRs" after reading none cannot look alike. When no source could be read the builder throws and
 * the job keeps the previous record.
 *
 * ⚠ The headlines are written by code from the numbers, not by a model. PR and item titles are
 * other people's text; they are stored as text and shown as text.
 */
import type { HubRecord } from './hub.js';
import type { RepoRead } from './collect.js';
import type { PlaneItem } from './plane.js';
import { ciStatus, clip, codexState, daysSince, isOpenItem, PLANE_BROWSE } from './snapshot.js';
import { countWeek, weekStart } from './merged.js';
import { localTime } from './schedule.js';
import type { WeekRecord } from './weekly.js';
import type { MonitorState } from '../lab/tools/kuma.js';

export const INSIGHT_KIND = 'insight';
/** An open PR or In Review item with no update for this many days is stuck. */
export const STUCK_DAYS = 3;
/** A week is "usual" within this fraction of the 8-week average. */
const USUAL_BAND = 0.3;
/** Part of the week that must have passed before a pace is judged. Earlier, one merge reads as a surge. */
const MIN_FRACTION = 0.3;
/** Weeks of history needed before a verdict on "usual". */
const MIN_HISTORY = 3;
const LIST_CAP = 12;
const HEADLINES = 5;
const DAY_MS = 86_400_000;

export type Level = 'bad' | 'warn' | 'info' | 'good';

export interface Headline {
  level: Level;
  text: string;
  /** The tab or page the line comes from. */
  link?: string;
}

export interface Row {
  kind: 'pr' | 'plane';
  key: string;
  title: string;
  url: string | null;
  days: number;
  why: string;
}

export interface Trend {
  label: string;
  now: number | null;
  last: number | null;
  avg: number | null;
  /** More is worse (open PRs, CVEs). */
  badUp: boolean;
  note: string;
  /** usual, higher, lower, or unknown. */
  verdict: 'usual' | 'higher' | 'lower' | 'unknown';
  /** False when either run read incompletely, so a rise or fall would be noise. Absent means comparable. */
  comparable?: boolean;
}

export interface Broke {
  what: string;
  detail: string;
}

export interface InsightInput {
  at: Date;
  /** Null when no repo could be read at all. */
  reads: RepoRead[];
  /** Null when Plane was not read; the string says why. */
  pet: { ok: true; items: PlaneItem[] } | { ok: false; error: string };
  kuma: { ok: true; monitors: MonitorState[] } | { ok: false; error: string };
  /** Stored weekly records, newest first. */
  weeks: WeekRecord[];
  /** Stored CVE records, newest first. */
  cve: HubRecord[];
  /** Stored Plane records, newest first. */
  planeHistory: HubRecord[];
  med: { ok: boolean; reason?: string };
}

const planeUrl = (seq: number): string => `${PLANE_BROWSE}/PET-${seq}/`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function prRows(reads: RepoRead[], at: Date): { needs: Row[]; stuck: Row[]; open: number; red: number; conflict: number } {
  const needs: Row[] = [];
  const stuck: Row[] = [];
  let open = 0;
  let red = 0;
  let conflict = 0;
  for (const r of reads) {
    if (!r.ok) continue;
    for (const p of r.open) {
      open++;
      const days = daysSince(p.updatedAt, at);
      const why: string[] = [];
      const ci = ciStatus(p.checks);
      if (ci === 'red') {
        why.push(`CI failing (${p.checks?.failed.slice(0, 2).join(', ')})`);
        red++;
      }
      if (p.mergeable === false) {
        why.push('merge conflict');
        conflict++;
      }
      const cx = codexState(p.codex, p.headSha);
      if (cx.kind === 'head' && cx.verdict === 'changes-requested') why.push('Codex requested changes');
      const escalated = cx.kind === 'head' && cx.verdict === 'escalate';
      if (escalated) why.push('Codex escalated it to you');
      if (p.draft) why.push('draft');
      const row = { kind: 'pr' as const, key: `${p.repo}#${p.number}`, title: clip(p.title, 90), url: p.url, days };
      if (escalated) needs.push({ ...row, why: why.join(', ') });
      else if (!p.draft && (days >= STUCK_DAYS || why.length)) stuck.push({ ...row, why: why.length ? why.join(', ') : `no update for ${days} days, nothing failing` });
    }
  }
  const byAge = (a: Row, b: Row): number => b.days - a.days;
  return { needs: needs.sort(byAge), stuck: stuck.sort(byAge), open, red, conflict };
}

function planeRows(items: PlaneItem[], at: Date): { needs: Row[]; stuck: Row[]; open: number } {
  const open = items.filter(isOpenItem);
  const age = (i: PlaneItem): number => daysSince(i.updatedAt, at);
  const needs = open
    .filter((i) => i.labels.includes('needs-pedro'))
    .map((i) => ({ kind: 'plane' as const, key: `PET-${i.seq}`, title: clip(i.name, 90), url: planeUrl(i.seq), days: age(i), why: `${i.stateName}, labelled needs-pedro${age(i) >= 0 ? `, untouched ${age(i)} days` : ''}` }))
    .sort((a, b) => b.days - a.days);
  const stuck = open
    .filter((i) => /review/i.test(i.stateName) && age(i) >= STUCK_DAYS)
    .map((i) => ({ kind: 'plane' as const, key: `PET-${i.seq}`, title: clip(i.name, 90), url: planeUrl(i.seq), days: age(i), why: `${i.stateName} for ${age(i)} days` }))
    .sort((a, b) => b.days - a.days);
  return { needs, stuck, open: open.length };
}

/** Fraction of the Eastern week that has passed, so a part-week count is compared with a pace and not a full week. */
export function weekFraction(at: Date): number {
  const start = Date.parse(`${weekStart(at)}T00:00:00Z`);
  const t = localTime(at);
  const days = (Date.parse(`${t.date}T00:00:00Z`) - start) / DAY_MS;
  return Math.min(1, Math.max(0.05, (days + t.minutes / 1440) / 7));
}

function verdictFor(pace: number | null, avg: number | null, history: number, frac: number): Trend['verdict'] {
  if (frac < MIN_FRACTION || pace == null || avg == null || history < MIN_HISTORY || avg <= 0) return 'unknown';
  if (pace > avg * (1 + USUAL_BAND)) return 'higher';
  if (pace < avg * (1 - USUAL_BAND)) return 'lower';
  return 'usual';
}

function mergedTrend(reads: RepoRead[], weeks: WeekRecord[], at: Date): Trend {
  const read = reads.filter((r) => r.ok);
  if (read.length === 0) return { label: 'PRs merged', now: null, last: null, avg: null, badUp: false, note: 'GitHub was not read', verdict: 'unknown' };
  const thisWeek = weekStart(at);
  const prev = weekStart(new Date(Date.parse(`${thisWeek}T12:00:00Z`) - 7 * DAY_MS));
  const now = countWeek(reads, thisWeek).total;
  const stored = new Map(weeks.map((w) => [w.week, w.total]));
  const last = stored.get(prev) ?? countWeek(reads, prev).total;
  const hist = weeks.filter((w) => w.week < thisWeek).slice(0, 8);
  const avg = hist.length ? hist.reduce((n, w) => n + w.total, 0) / hist.length : null;
  const frac = weekFraction(at);
  const pace = now / frac;
  const verdict = verdictFor(pace, avg, hist.length, frac);
  const floor = countWeek(reads, thisWeek).floorRepos.length > 0 || countWeek(reads, prev).floorRepos.length > 0;
  const note = `${now} so far, ${Math.round(frac * 100)}% of the week gone, a pace of about ${Math.round(pace)}` + (avg == null ? '; no earlier weeks stored' : `; ${hist.length}-week average ${Math.round(avg)}`) + (frac < MIN_FRACTION ? '; too early in the week to judge the pace' : '') + (floor ? '; the GitHub read hit its cap, so these counts are a floor' : '');
  return { label: 'PRs merged', now, last, avg: avg == null ? null : Math.round(avg), badUp: false, note, verdict };
}

function doneTrend(items: PlaneItem[] | null, at: Date): Trend {
  if (!items) return { label: 'Plane items done', now: null, last: null, avg: null, badUp: false, note: 'Plane was not read', verdict: 'unknown' };
  const done = new Map<string, number>();
  for (const i of items) {
    if (isOpenItem(i) || i.stateGroup === 'cancelled') continue;
    const t = Date.parse(i.updatedAt);
    if (!Number.isFinite(t)) continue;
    const w = weekStart(new Date(t));
    done.set(w, (done.get(w) ?? 0) + 1);
  }
  const thisWeek = weekStart(at);
  const prev = weekStart(new Date(Date.parse(`${thisWeek}T12:00:00Z`) - 7 * DAY_MS));
  const past = [...Array(8)].map((_, k) => weekStart(new Date(Date.parse(`${thisWeek}T12:00:00Z`) - (k + 1) * 7 * DAY_MS)));
  // A week with no completion counts as zero, but only for weeks the board reaches back to: the oldest completion read bounds them.
  const oldest = [...done.keys()].sort()[0];
  const covered = past.filter((w) => oldest != null && w >= oldest);
  const avg = covered.length ? covered.reduce((n, w) => n + (done.get(w) ?? 0), 0) / covered.length : null;
  const now = done.get(thisWeek) ?? 0;
  const pace = now / weekFraction(at);
  return {
    label: 'Plane items done',
    now,
    last: done.get(prev) ?? 0,
    avg: avg == null ? null : Math.round(avg),
    badUp: false,
    note: `counted by last-updated day, so a later edit moves an item; average over ${plural(covered.length, 'earlier week')}`,
    verdict: verdictFor(pace, avg, covered.length, weekFraction(at)),
  };
}

function cveTrend(cve: HubRecord[]): Trend {
  const [a, b] = cve;
  if (!a) return { label: 'Actionable CVEs', now: null, last: null, avg: null, badUp: true, note: 'no CVE run stored', verdict: 'unknown' };
  const now = Number(a.actionable);
  const last = b ? Number(b.actionable) : null;
  const complete = a.complete === true;
  const comparable = complete && !!b && b.complete === true;
  return {
    label: 'Actionable CVEs',
    now: Number.isFinite(now) ? now : null,
    last: last != null && Number.isFinite(last) ? last : null,
    comparable,
    avg: null,
    badUp: true,
    note: `run ${a.id}${complete ? '' : ', incomplete read'}; "last" is the run before it${b ? ` (${b.id})` : ''}`,
    verdict: 'unknown',
  };
}

function openTrend(openNow: number | null, planeHistory: HubRecord[]): Trend {
  const prev = planeHistory.find((r) => (r.pet as { ok?: boolean } | undefined)?.ok);
  const last = prev ? Number((prev.pet as { open?: number }).open) : null;
  return {
    label: 'Open Plane items',
    now: openNow,
    last: last != null && Number.isFinite(last) ? last : null,
    avg: null,
    badUp: true,
    note: prev ? `"last" is the stored board of ${prev.id}` : 'no earlier board stored',
    verdict: 'unknown',
  };
}

function brokeList(i: InsightInput): Broke[] {
  const out: Broke[] = [];
  if (i.kuma.ok) {
    for (const m of i.kuma.monitors.filter((x) => x.status !== 'up')) out.push({ what: `${m.name} is ${m.status}`, detail: m.message ? clip(m.message, 100) : m.since ? `since ${m.since}` : 'no detail from Kuma' });
  }
  const latest = i.cve[0];
  const before = i.cve[1];
  if (latest && Number(latest.exploited) > 0) out.push({ what: `${plural(Number(latest.exploited), 'known-exploited CVE')}`, detail: `in the ${latest.id} run${before ? `; the run before had ${before.exploited}` : ''}` });
  if (latest && latest.complete !== true) out.push({ what: 'The CVE run read incompletely', detail: clip(((latest.gaps as string[]) ?? []).join(' ') || 'gaps not recorded', 160) });
  return out;
}

export function insightRecord(i: InsightInput): HubRecord {
  const { at } = i;
  const read = i.reads.filter((r) => r.ok);
  const unread = i.reads.filter((r) => !r.ok).map((r) => r.repo);
  if (read.length === 0 && !i.pet.ok && !i.kuma.ok) throw new Error('no source could be read, so there is nothing to report');

  const gaps: string[] = [];
  /** Sources that are not set up or empty on purpose. Shown, but they never raise a headline. */
  const notes: string[] = [];
  if (i.reads.length === 0 || read.length === 0) gaps.push('GitHub was not read, so PR trends, stuck PRs and PRs that need you are missing');
  else if (unread.length) gaps.push(`GitHub: ${unread.join(', ')} not read`);
  if (!i.pet.ok) gaps.push(`Plane PET board not read: ${i.pet.error.slice(0, 120)}`);
  if (!i.med.ok) (i.med.reason?.startsWith('no MED project id') ? notes : gaps).push(`MED board not read: ${i.med.reason ?? 'unknown'}`);
  if (!i.kuma.ok) gaps.push(`Uptime Kuma not read: ${i.kuma.error.slice(0, 120)}`);
  if (i.cve.length === 0) notes.push('no CVE run is stored yet');

  const prs = read.length ? prRows(i.reads, at) : { needs: [], stuck: [], open: 0, red: 0, conflict: 0 };
  const pl = i.pet.ok ? planeRows(i.pet.items, at) : { needs: [], stuck: [], open: 0 };
  const needs = [...pl.needs, ...prs.needs];
  const stuck = [...prs.stuck, ...pl.stuck].sort((a, b) => b.days - a.days);
  const broke = brokeList(i);

  const trends: Trend[] = [mergedTrend(i.reads, i.weeks, at), doneTrend(i.pet.ok ? i.pet.items : null, at), openTrend(i.pet.ok ? pl.open : null, i.planeHistory), cveTrend(i.cve)];

  const heads: (Headline & { rank: number })[] = [];
  const add = (rank: number, level: Level, text: string, link?: string): void => void heads.push({ rank, level, text, link });
  const exploited = broke.find((b) => b.what.includes('exploited'));
  if (exploited) add(100, 'bad', `${exploited.what} ${exploited.detail}. Patch these first.`, 'cve');
  const down = broke.filter((b) => / is (down|pending)$/.test(b.what));
  if (down.length) add(95, 'bad', `${plural(down.length, 'monitor')} not up: ${down.slice(0, 3).map((d) => d.what.replace(/ is \w+$/, '')).join(', ')}${down.length > 3 ? ` and ${down.length - 3} more` : ''}.`);
  if (needs.length) {
    const top = needs[0]!;
    add(90, 'warn', `${plural(needs.length, 'item')} need${needs.length === 1 ? 's' : ''} you. The oldest is ${top.key}, ${top.why}.`);
  }
  if (prs.red + prs.conflict > 0) add(80, 'warn', `${plural(prs.red, 'open PR')} ${prs.red === 1 ? 'has' : 'have'} failing CI and ${plural(prs.conflict, 'PR')} ${prs.conflict === 1 ? 'has' : 'have'} a merge conflict, out of ${prs.open} open.`);
  if (stuck.length) {
    const top = stuck[0]!;
    add(70, 'warn', `${plural(stuck.length, 'item')} ${stuck.length === 1 ? 'has' : 'have'} sat ${STUCK_DAYS}+ days. The oldest is ${top.key} at ${top.days} days.`);
  }
  const m = trends[0]!;
  if (m.verdict === 'higher' || m.verdict === 'lower') add(50, m.verdict === 'higher' ? 'info' : 'warn', `Merging is ${m.verdict === 'higher' ? 'busier' : 'quieter'} than usual: ${m.note}.`, 'weekly');
  else if (m.verdict === 'usual') add(20, 'info', `Merging is on its usual pace: ${m.note}.`, 'weekly');
  const d = trends[1]!;
  if (d.verdict === 'lower') add(45, 'warn', `Plane completions are below the usual pace: ${d.now} done this week against a typical ${d.avg}.`, 'plane');
  const c = trends[3]!;
  if (c.comparable === false && c.now != null) add(40, 'info', 'CVE counts are not compared with the run before, because one of the two runs read incompletely.', 'cve');
  else if (c.now != null && c.last != null && c.now > c.last) add(60, 'warn', `Actionable CVEs rose from ${c.last} to ${c.now}.`, 'cve');
  else if (c.now != null && c.last != null && c.now < c.last) add(15, 'good', `Actionable CVEs fell from ${c.last} to ${c.now}.`, 'cve');
  if (gaps.length) add(85, 'warn', `${plural(gaps.length, 'source')} could not be fully read, so some numbers below are missing: ${gaps[0]}.`);
  const headlines: Headline[] = heads
    .sort((a, b) => b.rank - a.rank)
    .slice(0, HEADLINES)
    .map(({ rank: _r, ...h }) => h);
  if (!heads.some((h) => h.level === 'bad' || h.level === 'warn') && gaps.length === 0) headlines.unshift({ level: 'good', text: 'Nothing needs you, nothing is stuck and nothing is down, in the sources read below.' });

  const medTag = i.med.ok ? 'MED read' : 'MED not read';
  return {
    id: localTime(at).date,
    generatedAt: at.toISOString(),
    read: {
      github: { reposRead: read.length, reposTotal: i.reads.length, unread, openPrs: prs.open },
      plane: i.pet.ok ? { ok: true, items: i.pet.items.length, open: pl.open, med: medTag } : { ok: false, error: i.pet.error.slice(0, 160) },
      kuma: i.kuma.ok ? { ok: true, monitors: i.kuma.monitors.length } : { ok: false, error: i.kuma.error.slice(0, 160) },
      cve: { runs: i.cve.length, newest: i.cve[0]?.id ?? null },
      weeks: i.weeks.length,
    },
    stuckAfterDays: STUCK_DAYS,
    headlines,
    needsYou: needs.slice(0, LIST_CAP),
    needsYouTotal: needs.length,
    stuck: stuck.slice(0, LIST_CAP),
    stuckTotal: stuck.length,
    trends,
    /** Merged PRs per week, oldest first; the last entry is the week in progress (partial). */
    mergedSeries: [
      ...i.weeks.filter((w) => w.week < weekStart(at)).slice(0, 7).reverse().map((w) => ({ week: w.week, total: w.total, partial: false })),
      ...(trends[0]!.now == null ? [] : [{ week: weekStart(at), total: trends[0]!.now, partial: true }]),
    ],
    broke,
    gaps,
    notes,
  };
}
