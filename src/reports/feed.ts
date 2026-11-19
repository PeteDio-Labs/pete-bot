/**
 * GET /api/dashboard: the SPA's feed, built from what pete-bot holds. It is the local twin of the
 * AWS feed and has the same shape, so the SPA cannot tell them apart.
 *
 * ⚠ A SECTION THIS BUILDER CANNOT READ IS LEFT OUT, NEVER FILLED WITH ZEROS. The SPA names a
 * missing section in a banner and treats it as unknown. Open alerts come from the alert store;
 * the CVE and Plane sections come from the newest hub record. `services` comes from the failover registry
 * and a live read of each lab side (src/failover). `triage` and `history` have no source here yet,
 * so they are absent on purpose.
 */
import type { AlertBatch } from '../server/alertStore.js';
import type { WeekRecord } from './weekly.js';
import type { HubRecord, ReportHub } from './hub.js';
import { CVE_KIND } from './hubCve.js';
import { CYCLE_KIND } from './hubCycle.js';

const NOTE_RE = /Suggested by the local model \(unverified\):\*\*\s*(.+?)(?:\nWhy:\s*(.+))?$/s;
const SEVERITY: Record<string, string> = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'medium', LOW: 'low', unrated: 'low' };

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

function newest(hub: ReportHub, kind: string): HubRecord | null {
  const { records } = hub.list(kind);
  return records[0] ?? null;
}

/**
 * The cycle's progress, split and open items, passed through as the record holds them. A record from before these
 * fields existed adds nothing, and the SPA then shows the counts alone.
 */
function cycleDetail(p: HubRecord): Record<string, unknown> {
  if (typeof p.total !== 'number' || typeof p.done !== 'number') return {};
  const c = rec(p.cycle);
  return {
    total: p.total,
    done: p.done,
    inProgress: typeof p.inProgress === 'number' ? p.inProgress : undefined,
    start: c.start,
    end: c.end,
    byRoute: p.byRoute,
    // The producer caps this list at 15, so `open` beside it is the full count.
    openItems: Array.isArray(p.openItems) ? p.openItems : undefined,
  };
}

export interface FeedInput {
  hub: ReportHub | null;
  batches: AlertBatch[];
  now: Date;
  /** Registry rows with their lab readings. Absent, the section is empty and the SPA reads every service as unknown. */
  services?: unknown[];
  /** The staging box's 24-hour clock from lab-agent. Absent, the feed carries no staging section. */
  staging?: Record<string, unknown> | null;
  /** The newest stored weekly PR record, or null when none is stored. */
  week?: WeekRecord | null;
}

export function buildDashboardFeed({ hub, batches, now, services, staging, week }: FeedInput): Record<string, unknown> {
  const alerts: Record<string, unknown>[] = [];
  const needs: Record<string, unknown>[] = [];
  for (const b of batches) {
    for (const [monitor, st] of Object.entries(b.monitors)) {
      const down = st.recoveredAt === undefined;
      const since = new Date(st.since).toISOString();
      const m = st.note ? NOTE_RE.exec(st.note) : null;
      alerts.push({ monitor, state: down ? 'down' : 'up', since, triage: m ? 'act' : 'off', ...(m ? { step: m[1]!.trim(), why: m[2]?.trim() } : {}) });
      if (down && m) needs.push({ id: `${b.id}:${monitor}`, title: monitor, why: m[2]?.trim() ?? '', step: m[1]!.trim(), since });
    }
  }

  let cve: Record<string, unknown> | undefined;
  let plane: Record<string, unknown> | undefined;
  if (hub) {
    const c = newest(hub, CVE_KIND);
    if (c) {
      const ex = rec(c.examined);
      const top = Array.isArray(c.top) ? c.top : [];
      cve = {
        checkedAt: c.generatedAt,
        hosts: ex.hostsRead ?? 0,
        packages: ex.queries ?? 0,
        advisories: ex.advisories ?? 0,
        // The detail list below is capped by the producer, so the full exploited count travels beside it.
        exploited: typeof c.exploited === 'number' ? c.exploited : undefined,
        notChecked: Array.isArray(ex.hostsUnread) ? ex.hostsUnread : [],
        // What the run could not examine, and whether the exploited list was read, so a gap never reads as clear.
        gaps: Array.isArray(c.gaps) ? c.gaps : ['the record carries no gap list, so completeness is unknown'],
        kevChecked: c.complete === true || (typeof ex.kevEntries === 'number' && ex.kevEntries > 0 && !(Array.isArray(c.gaps) && c.gaps.some((g) => /exploit|kev|cisa/i.test(String(g))))),
        findings: top.map((t) => {
          const f = rec(t);
          return { id: f.cve ?? 'unknown', pkg: f.package, host: Array.isArray(f.hosts) ? f.hosts[0] ?? '' : '', severity: SEVERITY[String(f.severity)] ?? 'low', fixed: f.fixed ?? null, kev: f.kev === true };
        }),
      };
    }
    const p = newest(hub, CYCLE_KIND);
    // A cycle record with no cycle, or from before the in-review count existed, has nothing to show.
    if (p && typeof p.open === 'number' && typeof p.inReview === 'number') plane = { checkedAt: p.generatedAt, open: p.open, needsPedro: typeof p.needsPedro === 'number' ? p.needsPedro : undefined, inReview: p.inReview, cycle: rec(p.cycle).name, lost: typeof p.lost === 'number' ? p.lost : undefined, ...cycleDetail(p) };
  }

  // A stored record that does not have the expected shape must not take the live sections down with it.
  let shipped: Record<string, unknown> | null = null;
  if (week) {
    try {
      shipped = shippedSection(week);
    } catch {
      shipped = null;
    }
  }

  return {
    generatedAt: now.toISOString(),
    source: 'pete-bot',
    needs,
    alerts,
    services: services ?? [],
    ...(cve ? { cve } : {}),
    ...(plane ? { plane } : {}),
    ...(shipped ? { shipped } : {}),
    ...(staging ? { staging } : {}),
  };
}

/** The week's PR report, bounded: the newest ten PRs and the eight busiest repos. */
function shippedSection(w: WeekRecord): Record<string, unknown> {
  const repos = Object.entries(w.byRepo).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([repo, count]) => ({ repo, count }));
  const prs = [...w.merged].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)).slice(0, 10).map((p) => ({ repo: p.repo, number: p.number, title: p.title, author: p.author }));
  return {
    week: w.week,
    generatedAt: w.generatedAt,
    total: w.total,
    openNow: w.openNow,
    reposRead: w.coverage.reposRead,
    reposTotal: w.coverage.reposTotal,
    unread: w.coverage.unread.slice(0, 10),
    // Repos whose read stopped inside the week, so the total is a lower bound.
    capped: w.coverage.floorRepos.slice(0, 10),
    repos,
    prs,
    ...(w.summary.source === 'ollama' && w.summary.text ? { summary: w.summary.text.slice(0, 800) } : {}),
  };
}
