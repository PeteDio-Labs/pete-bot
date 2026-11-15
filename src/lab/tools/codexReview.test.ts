import { describe, expect, it } from 'bun:test';
import { codexReviewStatusTool, queueCodexReviewTool } from './codexReview.js';

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const cfg = (f: (url: string, init?: RequestInit) => Promise<Response>) => ({ url: 'http://127.0.0.1:3015/v1/codex-review', token: 'tok', fetch: f as unknown as typeof fetch });

describe('request_codex_review', () => {
  it('is marked as not read-only and posts the repo, PR and effort with the bearer', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const t = queueCodexReviewTool(cfg(async (url, init) => ((seen = { url, init }), reply({ ok: true, kind: 'queued' }, 202))));
    expect(t.readOnly).toBe(false);
    const out = await t.run({ repo: 'pete-bot', pr: 7, effort: 'high' });
    expect(seen!.init!.method).toBe('POST');
    expect((seen!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(seen!.init!.body as string)).toEqual({ repo: 'pete-bot', pr: 7, effort: 'high' });
    expect(out.source).toContain('pete-bot#7');
  });

  it('fails loudly: refused repo, bad token, desk off, unreachable', async () => {
    const run = (f: Parameters<typeof cfg>[0]) => queueCodexReviewTool(cfg(f)).run({ repo: 'x', pr: 1 });
    await expect(run(async () => reply({ detail: 'x is not on the desk list' }, 403))).rejects.toThrow('refused: x is not on the desk list');
    await expect(run(async () => reply({}, 401))).rejects.toThrow('401');
    await expect(run(async () => reply({}, 503))).rejects.toThrow('desk is off');
    await expect(run(async () => { throw new Error('ECONNREFUSED'); })).rejects.toThrow('unreachable');
  });
});

describe('check_codex_review', () => {
  it('reads with GET and counts the reviews', async () => {
    let url = '';
    const t = codexReviewStatusTool(cfg(async (u) => ((url = u), reply({ head: 'a', request: { state: 'rate_limited' }, reviews: [] }))));
    expect(t.readOnly).toBeUndefined();
    const out = await t.run({ repo: 'pete-bot', pr: 7 });
    expect(url).toBe('http://127.0.0.1:3015/v1/codex-review?repo=pete-bot&pr=7');
    expect(out.source).toContain('0 Codex review(s)');
    expect((out.data as { request: { state: string } }).request.state).toBe('rate_limited');
  });
});
