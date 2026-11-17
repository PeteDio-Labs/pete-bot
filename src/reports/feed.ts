/**
 * GET /api/dashboard: the SPA's feed, built from what pete-bot holds. It is the local twin of the
 * AWS feed and has the same shape, so the SPA cannot tell them apart.
 *
 * ⚠ A SECTION THIS BUILDER CANNOT READ IS LEFT OUT, NEVER FILLED WITH ZEROS. The SPA names a
 * missing section in a banner and treats it as unknown. Open alerts come from the alert store;
 * the CVE and Plane sections come from the newest hub record. `services`, `triage` and `history`
 * have no source here yet (the registry and the triage ledger are not built), so they are empty
 * or absent on purpose.
 */
import type { AlertBatch } from '../server/alertStore.js';
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

export interface FeedInput {
  hub: ReportHub | null;
  batches: AlertBatch[];
  now: Date;
}

export function buildDashboardFeed({ hub, batches, now }: FeedInput): Record<string, unknown> {
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
        notChecked: Array.isArray(ex.hostsUnread) ? ex.hostsUnread : [],
        findings: top.map((t) => {
          const f = rec(t);
          return { id: f.cve ?? 'unknown', pkg: f.package, host: Array.isArray(f.hosts) ? f.hosts[0] ?? '' : '', severity: SEVERITY[String(f.severity)] ?? 'low', fixed: f.fixed ?? null, kev: f.kev === true };
        }),
      };
    }
    const p = newest(hub, CYCLE_KIND);
    // A cycle record with no cycle, or from before the in-review count existed, has nothing to show.
    if (p && typeof p.open === 'number' && typeof p.inReview === 'number') plane = { checkedAt: p.generatedAt, open: p.open, needsPedro: p.needsPedro ?? 0, inReview: p.inReview };
  }

  return {
    generatedAt: now.toISOString(),
    source: 'pete-bot',
    needs,
    alerts,
    services: [],
    ...(cve ? { cve } : {}),
    ...(plane ? { plane } : {}),
  };
}
