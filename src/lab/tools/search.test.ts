import { describe, expect, it } from 'bun:test';
import { searchLabTool, MAX_CHUNK_CHARS } from './search.js';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tool = (f: (url: string, init?: RequestInit) => Promise<Response>) =>
  searchLabTool({ baseUrl: 'http://s:8526', token: 'tok', fetch: f as unknown as typeof fetch });

describe('search_lab', () => {
  it('sends the bearer, passes source and k, and trims each chunk', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const t = tool(async (url, init) => {
      seen = { url, init };
      return reply({ hits: [{ score: 0.9, source: 'repo', ref: 'petedio-iac/docs/GOTCHAS.md', title: 't', text: 'x'.repeat(2000) }] });
    });
    const out = await t.run({ query: 'co-owned lxc', source: 'repo', k: 3 });
    expect(seen!.url).toBe('http://s:8526/api/search?q=co-owned+lxc&k=3&source=repo');
    expect((seen!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(out.source).toContain('1 chunks');
    expect((out.data as { hits: Array<{ text: string }> }).hits[0]!.text).toHaveLength(MAX_CHUNK_CHARS);
  });

  it('fails loudly on 401, 502, a bad body and an unreachable host', async () => {
    await expect(tool(async () => reply({}, 401)).run({ query: 'abc' })).rejects.toThrow('refused the lab-agent token');
    await expect(tool(async () => reply({}, 502)).run({ query: 'abc' })).rejects.toThrow('embedding lane');
    await expect(tool(async () => reply({ nope: 1 })).run({ query: 'abc' })).rejects.toThrow('no hits field');
    await expect(tool(async () => { throw new Error('ECONNREFUSED'); }).run({ query: 'abc' })).rejects.toThrow('unreachable');
  });

  it('reports zero hits as a count, not as a failure', async () => {
    const out = await tool(async () => reply({ hits: [] })).run({ query: 'nothing here' });
    expect(out.source).toContain('0 chunks');
  });
});
