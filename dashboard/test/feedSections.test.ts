import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../src/reports/ledger.ts';
import { ReportHub } from '../../src/reports/hub.ts';
import { buildDashboardFeed } from '../../src/reports/feed.ts';
import { parseDashboard } from '../src/model.ts';

const since = Date.parse('2026-11-24T10:00:00Z');
const batch = () => ({ id: 'b1', openedAt: since, lastAddedAt: since, monitors: { plex: { since, checks: 1 } } });

describe('the live feed carries the sections the page reads', () => {
  it('takes CVE days from the hub and the page parses the whole feed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const hub = new ReportHub(dir);
    hub.save('cve', { id: '2026-11-23', generatedAt: '2026-11-23T06:00:00Z', bySeverity: { CRITICAL: 1, HIGH: 2, MODERATE: 3, LOW: 4, unrated: 9 } });
    const l = new Ledger(dir);
    const now = new Date('2026-11-24T12:00:00Z');
    l.observe(now, [batch()], [{ name: 'plex', lab: { ok: true, checkedAt: now.toISOString(), detail: '' } }]);
    const backups = { checkedAt: now.toISOString(), guests: [{ guest: 'plex', lastGood: now.toISOString(), detail: '' }] };
    const feed = buildDashboardFeed({ hub, batches: [], now, services: [], backups, history: l.history(now, hub), triage: l.triage(now) });
    const r = parseDashboard(JSON.parse(JSON.stringify(feed)));
    expect(r.problems.filter((p) => /triage|history|backup/.test(p))).toEqual([]);
    expect(r.data.history?.cve).toEqual([{ day: '2026-11-23', critical: 1, high: 2, medium: 3, low: 4 }]);
    expect(r.data.backups?.guests.length).toBe(1);
    expect(r.data.triage?.read).toBe(1);
  });
});
