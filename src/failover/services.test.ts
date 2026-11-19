import { describe, it, expect } from 'bun:test';
import { buildServices, buildSites } from './services.js';
import type { RegistryEntry } from './registry.js';

const now = new Date('2026-11-18T12:00:00Z');
const reg: RegistryEntry[] = [
  { name: 'a', hostname: 'a.test', dataClass: 'stateless', pinned: false, labUrl: 'https://a.test/h' },
  { name: 'b', hostname: 'b.test', dataClass: 'replicated', pinned: false, labUrl: 'https://b.test/h' },
  { name: 'c', hostname: 'c.test', dataClass: 'snapshot', pinned: false, labUrl: 'https://c.test/h' },
  { name: 'd', hostname: 'd.test', dataClass: 'snapshot', pinned: true },
];
const fake = async (url: string) => {
  if (url.includes('a.test')) return { status: 200 };
  if (url.includes('b.test')) return { status: 503 };
  return { status: 302 };
};

describe('buildServices', () => {
  it('reads each lab side, and leaves a service with no URL or a redirect unknown', async () => {
    const rows = await buildServices(now, fake, reg);
    expect(rows.map((r) => r.lab?.ok ?? null)).toEqual([true, false, null, null]);
    expect(rows.every((r) => r.cloud === null)).toBe(true);
    expect(rows[3]!.pinned).toBe(true);
  });
  it('reports a failed fetch as down with the reason, not as healthy', async () => {
    const rows = await buildServices(now, async () => { throw new Error('boom'); }, reg.slice(0, 1));
    expect(rows[0]!.lab).toMatchObject({ ok: false, detail: 'no answer (Error)' });
  });
});

describe('buildSites', () => {
  const sites = [
    { name: 'S', env: 'production' as const, url: 'https://up.test/' },
    { name: 'S', env: 'staging' as const, url: 'https://login.test/' },
    { name: 'T', env: 'production' as const, url: 'https://down.test/' },
  ];
  it('reads a site up, a redirect as unknown and a failure as down', async () => {
    const rows = await buildSites(now, async (u) => ({ status: u.includes('up.') ? 200 : 302 }), sites.slice(0, 2));
    expect(rows.map((r) => r.reading?.ok ?? null)).toEqual([true, null]);
    const down = await buildSites(now, async () => { throw new Error('x'); }, sites.slice(2));
    expect(down[0]!.reading).toMatchObject({ ok: false, detail: 'no answer (Error)' });
  });
});
