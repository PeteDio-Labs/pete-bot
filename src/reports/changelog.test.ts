import { describe, expect, test } from 'bun:test';
import { parseChangelog, readChangelog, rowsForWeek } from './changelog.js';
import { buildWeek, type WeekRecord } from './weekly.js';
import type { GithubReads } from './collect.js';

const MD = `---
type: system
---
# Stack changelog

| Date | Area | Status | Before | Now | Source |
|---|---|---|---|---|---|
| 2026-11-18 | Vault unseal | done | Shamir seal | AWS KMS auto-unseal | PET-946, [[223-vault]] |
| 2026-11-10 | Hosts | done | pasted prompts | PET comments | PET-948 |
| not a date | x | x | x | x | x |
`;

const b64 = (s: string): string => Buffer.from(s).toString('base64');
const ghWith = (impl: () => unknown): GithubReads => ({ get: async () => impl(), getPull: async () => { throw new Error('unused'); }, listReviews: async () => [], checks: async () => { throw new Error('unused'); } }) as unknown as GithubReads;

describe('stack changelog', () => {
  test('parses dated rows only, strips wikilinks', () => {
    const { rows, tableRows } = parseChangelog(MD);
    expect(tableRows).toBe(5);
    expect(rows.map((r) => r.date)).toEqual(['2026-11-18', '2026-11-10']);
    expect(rows[0]!.source).toBe('PET-946, 223-vault');
  });

  test('rowsForWeek keeps Monday to Sunday, newest first', () => {
    const { rows } = parseChangelog(MD);
    expect(rowsForWeek(rows, '2026-11-16').map((r) => r.area)).toEqual(['Vault unseal']);
    expect(rowsForWeek(rows, '2026-11-09').map((r) => r.area)).toEqual(['Hosts']);
    expect(rowsForWeek(rows, '2026-11-02')).toEqual([]);
  });

  test('a read failure says so and never returns an empty list', async () => {
    const r = await readChangelog(ghWith(() => { throw new Error('HTTP 404'); }), 'o');
    expect(r).toEqual({ read: false, reason: 'HTTP 404' });
  });

  test('a file with no table is a failed read', async () => {
    const r = await readChangelog(ghWith(() => ({ encoding: 'base64', content: b64('# empty\n') })), 'o');
    expect(r.read).toBe(false);
  });

  test('a good read returns rows', async () => {
    const r = await readChangelog(ghWith(() => ({ encoding: 'base64', content: b64(MD) })), 'o');
    expect(r.read && r.rows.length).toBe(2);
  });

  test('buildWeek stores the unread reason on the record', async () => {
    const gh = {
      get: async () => [],
      getPull: async () => { throw new Error('unused'); },
      listReviews: async () => [],
      checks: async () => { throw new Error('unused'); },
    } as unknown as GithubReads;
    const rec: WeekRecord = await buildWeek(gh, 'o', ['a'], '2026-11-16', new Date('2026-11-22T23:00:00Z'), async () => 'x', async () => ({ read: false, reason: 'HTTP 404' }));
    expect(rec.changes).toEqual({ read: false, reason: 'HTTP 404' });
  });
});
