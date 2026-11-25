import { describe, expect, it } from 'bun:test';
import { parseDashboard } from '../src/model.ts';

// The shapes src/reports/ledger.ts and lab-agent's /v1/backups produce. src/reports/ledger.test.ts pins the producer side;
// this file pins that the page reads them, without importing server code the dashboard has no dependencies for.
describe('the live feed carries the sections the page reads', () => {
  it('parses history, triage and backups as the ledger and lab-agent write them', () => {
    const now = '2026-11-24T12:00:00.000Z';
    const feed = {
      generatedAt: now,
      source: 'pete-bot',
      needs: [],
      alerts: [],
      services: [],
      history: {
        alerts: [{ day: '2026-11-24', act: 1, noAction: 0, unreadable: 2 }],
        cve: [{ day: '2026-11-23', critical: 1, high: 2, medium: 3, low: 4 }],
        drills: [],
        uptime: { plex: [{ at: now, state: 'ok' }, { at: '2026-11-24T12:40:00.000Z', state: 'unknown' }] },
      },
      triage: { read: 3, cards: 1, plain: 2, failures: 0, since: '2026-11-24' },
      backups: { checkedAt: now, guests: [{ guest: 'plex', lastGood: now, detail: 'Newest copy on pbs.' }, { guest: 'vault', lastGood: null, detail: 'No backup copy was found on the 1 storage read.' }] },
    };
    const r = parseDashboard(JSON.parse(JSON.stringify(feed)));
    expect(r.problems.filter((p) => /triage|history|backup/.test(p))).toEqual([]);
    expect(r.data.history?.cve).toEqual([{ day: '2026-11-23', critical: 1, high: 2, medium: 3, low: 4 }]);
    expect(r.data.history?.uptime.plex?.map((c) => c.state)).toEqual(['ok', 'unknown']);
    expect(r.data.backups?.guests.map((g) => g.lastGood)).toEqual([now, null]);
    expect(r.data.triage).toEqual({ read: 3, cards: 1, plain: 2, failures: 0, since: '2026-11-24' });
    expect(r.data.unread).toEqual([]);
  });
});
