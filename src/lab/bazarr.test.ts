/**
 * Bazarr for the media assistant (PET-869): the two reads, the one write, and the proposal
 * tool that is the model's only way to ask for a change.
 */
import { describe, it, expect, vi } from 'bun:test';
import { z } from 'zod';
import { ask, type CallModel, type ModelResponse } from './agent.js';
import { createLabHandler } from './server.js';
import { callTool, inputJsonSchema, type LabTool } from './tools/index.js';
import { bazarrFindTool, bazarrStatusTool, matchTitle, searchMissing } from './tools/bazarr.js';
import { proposeActionTool } from './tools/propose.js';

const CFG = { baseUrl: 'http://192.168.50.222:6767/', apiKey: 'k'.repeat(32) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const SERIES = { data: [{ sonarrSeriesId: 12, title: 'Survivor', episodeMissingCount: 4 }, { sonarrSeriesId: 13, title: 'Survivor: Edge of Extinction', episodeMissingCount: 0 }, { sonarrSeriesId: 20, title: 'Dexter: Resurrection', episodeMissingCount: 2 }] };
const MOVIES = { data: [{ radarrId: 7, title: 'Never After Dark', missing_subtitles: [{ code2: 'en' }] }] };
const router = (extra: Record<string, () => Response> = {}) =>
  vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (extra[path]) return extra[path]!();
    if (path === '/api/series') return json(SERIES);
    if (path === '/api/movies') return json(MOVIES);
    return json({}, 404);
  });

describe('matchTitle', () => {
  const items = [
    { kind: 'series' as const, id: 12, title: 'Survivor', missing: 4 },
    { kind: 'series' as const, id: 13, title: 'Survivor: Edge of Extinction', missing: 0 },
  ];
  it('prefers an exact title over a partial one', () => {
    expect(matchTitle(items, 'survivor').map((i) => i.id)).toEqual([12]);
  });
  it('falls back to a partial match, and returns nothing for an empty query', () => {
    expect(matchTitle(items, 'edge of').map((i) => i.id)).toEqual([13]);
    expect(matchTitle(items, '  ')).toEqual([]);
  });
});

describe('bazarr_find', () => {
  it('sends the key as a header, never in the URL, and names how many it read', async () => {
    const f = router();
    const res = await callTool(bazarrFindTool({ ...CFG, fetch: f as never }), { title: 'dexter' });
    expect(res.ok && res.text).toContain('Dexter: Resurrection');
    expect(res.ok && res.text).toContain('4 titles read from Bazarr, 1 match');
    for (const [url, init] of f.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).not.toContain(CFG.apiKey);
      expect(init.headers).toMatchObject({ 'x-api-key': CFG.apiKey });
    }
  });
  it('lists every title with missing subtitles when asked for missing only, with no title', async () => {
    const res = await callTool(bazarrFindTool({ ...CFG, fetch: router() as never }), { missingOnly: true });
    expect(res.ok && res.text).toContain('Survivor');
    expect(res.ok && res.text).toContain('Never After Dark');
    expect(res.ok && res.text).not.toContain('Edge of Extinction');
    expect(res.ok && res.text).toContain('3 have missing subtitles');
  });
  it('advertises a JSON schema, and refuses an unknown key', async () => {
    const tool = bazarrFindTool({ ...CFG, fetch: router() as never });
    expect(inputJsonSchema(tool.input)).toMatchObject({ type: 'object', additionalProperties: false, properties: { missingOnly: { type: 'boolean' } } });
    const res = await callTool(tool, { query: 'x' });
    expect(!res.ok && res.error).toContain('invalid input');
  });
  it('rejects a call with neither a title nor missingOnly', async () => {
    const res = await callTool(bazarrFindTool({ ...CFG, fetch: router() as never }), {});
    expect(res.ok).toBe(false);
  });
  it('fails on a 401 and a body with no data list, never an empty result', async () => {
    const a = await callTool(bazarrFindTool({ ...CFG, fetch: router({ '/api/series': () => json({}, 401) }) as never }), { title: 'dexter' });
    expect(!a.ok && a.error).toContain('refused the lab-agent key');
    const b = await callTool(bazarrFindTool({ ...CFG, fetch: router({ '/api/series': () => json({ nope: 1 }) }) as never }), { title: 'dexter' });
    expect(!b.ok && b.error).toContain('no data list');
  });
});

describe('bazarr_status', () => {
  it('reads badges, health and providers', async () => {
    const f = router({ '/api/badges': () => json({ episodes: 135 }), '/api/system/health': () => json({ data: [] }), '/api/providers': () => json({ data: [{ name: 'opensubtitlescom', status: 'DownloadLimitExceeded' }] }) });
    const res = await callTool(bazarrStatusTool({ ...CFG, fetch: f as never }), {});
    expect(res.ok && res.text).toContain('DownloadLimitExceeded');
    expect(res.ok && res.text).toContain('135');
  });
});

describe('searchMissing', () => {
  it('patches one series with the search-missing action and reports acceptance', async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const msg = await searchMissing({ ...CFG, fetch: f as never }, 'series', 12);
    const [url, init] = f.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://192.168.50.222:6767/api/series');
    expect(init.method).toBe('PATCH');
    expect(String(init.body)).toBe('seriesid=12&action=search-missing');
    expect(msg).toContain('accepted the search (HTTP 204)');
  });
  it('uses radarrid for a movie', async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await searchMissing({ ...CFG, fetch: f as never }, 'movie', 7);
    expect(String((f.mock.calls[0]![1] as RequestInit).body)).toBe('radarrid=7&action=search-missing');
  });
  it.each([[401], [500]])('throws on HTTP %s', async (status) => {
    await expect(searchMissing({ ...CFG, fetch: (async () => new Response('{}', { status })) as never }, 'series', 1)).rejects.toThrow('bazarr');
  });
  it('refuses a fractional or negative id before any request', async () => {
    const f = vi.fn();
    await expect(searchMissing({ ...CFG, fetch: f as never }, 'series', 1.5)).rejects.toThrow('whole number');
    await expect(searchMissing({ ...CFG, fetch: f as never }, 'series', -1)).rejects.toThrow('whole number');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('propose_action', () => {
  const tool = (bazarr = true) => proposeActionTool(bazarr ? { ...CFG, fetch: router() as never } : undefined);
  const proposalOf = (text: string) => (JSON.parse(text) as { data: { proposal: Record<string, unknown> } }).data.proposal;

  it('resolves one title to one Bazarr item and marks it as needing a tap', async () => {
    const res = await callTool(tool(), { action: 'subtitles', title: 'Never After Dark' });
    expect(res.ok && proposalOf(res.text)).toMatchObject({ action: 'subtitles', kind: 'movie', id: 7, confirm: true });
    expect(res.ok && res.text).toContain('Nothing has run');
  });
  it('refuses an ambiguous title and lists the candidates', async () => {
    const res = await callTool(tool(), { action: 'subtitles', title: 'surviv' });
    expect(!res.ok && res.error).toContain('matches 2 titles');
  });
  it('refuses an unknown title, a missing title and a host with no Bazarr', async () => {
    expect((await callTool(tool(), { action: 'subtitles', title: 'Nope Nope' })).ok).toBe(false);
    expect((await callTool(tool(), { action: 'subtitles' })).ok).toBe(false);
    expect((await callTool(tool(false), { action: 'subtitles', title: 'Survivor' })).ok).toBe(false);
  });
  it('proposes an update check without confirmation and an apply with it', async () => {
    const c = await callTool(tool(), { action: 'update_check', target: 'plex' });
    const a = await callTool(tool(), { action: 'update_apply', target: 'plex-and-arr' });
    expect(c.ok && proposalOf(c.text)).toMatchObject({ action: 'update_check', confirm: false });
    expect(c.ok && c.text).not.toMatch(/must tap Confirm/);
    expect(c.ok && c.text).toMatch(/Do not tell the user to confirm/);
    expect(a.ok && proposalOf(a.text)).toMatchObject({ action: 'update_apply', confirm: true });
  });
  it('refuses an update without a target and a target outside the list', async () => {
    expect((await callTool(tool(), { action: 'update_apply' })).ok).toBe(false);
    expect((await callTool(tool(), { action: 'update_apply', target: 'qbittorrent' })).ok).toBe(false);
    expect((await callTool(tool(), { action: 'delete_library' })).ok).toBe(false);
  });
});

function scripted(responses: ModelResponse[]): CallModel {
  let i = 0;
  return async () => {
    const r = responses[i++];
    if (!r) throw new Error('script exhausted');
    return r;
  };
}

describe('the loop collects proposals from the tool output, not from the model text', () => {
  it('returns the proposal and ignores one the model only wrote', async () => {
    const tools = new Map<string, LabTool>([['propose_action', proposeActionTool({ ...CFG, fetch: router() as never })]]);
    const res = await ask(
      'get subtitles for Never After Dark',
      tools,
      scripted([
        { content: [{ type: 'tool_use', id: 't1', name: 'propose_action', input: { action: 'subtitles', title: 'Never After Dark' } }], stop_reason: 'tool_use' },
        { content: [{ type: 'text', text: 'Proposed. {"proposal":{"action":"update_apply","target":"plex","label":"x","confirm":false}}' }], stop_reason: 'end_turn' },
      ]),
      'm',
    );
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]).toMatchObject({ action: 'subtitles', id: 7 });
  });
  it('returns none when the proposal failed', async () => {
    const tools = new Map<string, LabTool>([['propose_action', proposeActionTool({ ...CFG, fetch: router() as never })]]);
    const res = await ask('q', tools, scripted([
      { content: [{ type: 'tool_use', id: 't1', name: 'propose_action', input: { action: 'subtitles', title: 'surviv' } }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Which one?' }], stop_reason: 'end_turn' },
    ]), 'm');
    expect(res.proposals).toEqual([]);
    expect(res.toolCalls).toEqual([{ name: 'propose_action', ok: false }]);
  });
});

describe('POST /v1/media/act', () => {
  const ASK = 'a'.repeat(40);
  const noTool: LabTool = { name: 'x', description: 'd', input: z.object({}), run: async () => ({ source: 's', data: {} }) };
  const post = (body: unknown, token = ASK) =>
    new Request('http://127.0.0.1:3016/v1/media/act', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const make = (actBazarr?: (k: 'series' | 'movie', id: number) => Promise<string>) =>
    createLabHandler({ askToken: ASK, tools: new Map([['x', noTool]]), callModel: async () => ({ content: [], stop_reason: 'end_turn' }), model: 'm', checks: {}, actBazarr });

  it('runs the confirmed search and returns its message', async () => {
    const act = vi.fn().mockResolvedValue('accepted');
    const res = await make(act)(post({ kind: 'series', id: 12 }));
    expect(await res.json()).toEqual({ ok: true, message: 'accepted' });
    expect(act).toHaveBeenCalledWith('series', 12);
  });
  it('answers 404 without Bazarr, 401 for a wrong bearer, and 400 for a bad body', async () => {
    expect((await make()(post({ kind: 'series', id: 1 }))).status).toBe(404);
    expect((await make(vi.fn())(post({ kind: 'series', id: 1 }, 'b'.repeat(40)))).status).toBe(401);
    for (const bad of [{ kind: 'tv', id: 1 }, { kind: 'series', id: 'x' }, { kind: 'series', id: 1, extra: 1 }, { kind: 'series', id: -1 }]) {
      expect((await make(vi.fn())(post(bad))).status).toBe(400);
    }
  });
  it('answers 502 with the reason when Bazarr refuses, and never an internal message', async () => {
    const { LabToolError } = await import('./tools/index.js');
    const res = await make(async () => { throw new LabToolError('bazarr refused the lab-agent key (HTTP 401)'); })(post({ kind: 'series', id: 1 }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'bazarr refused the lab-agent key (HTTP 401)' });
    const res2 = await make(async () => { throw new TypeError('secret path /etc/x'); })(post({ kind: 'series', id: 1 }));
    expect(JSON.stringify(await res2.json())).not.toContain('/etc/x');
  });
});
