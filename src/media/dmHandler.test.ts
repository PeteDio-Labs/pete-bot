/**
 * The media assistant's DM gate (PET-869): who is answered, what a failure looks like,
 * and what the history carries.
 */
import { describe, it, expect, vi } from 'bun:test';
import { chunk, createDmHandler, describe as describeOutcome, HISTORY_TURNS } from './dmHandler.js';
import { askMedia, type MediaOutcome } from '../clients/mediaAgent.js';

const OWNER = '111111111111111111';
const CFG = { url: 'http://127.0.0.1:3016', token: 't'.repeat(32), timeoutMs: 1000 };

function msg(opts: { id?: string; bot?: boolean; guild?: string | null; content?: string } = {}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const sendTyping = vi.fn().mockResolvedValue(undefined);
  const message = {
    author: { id: opts.id ?? OWNER, bot: opts.bot ?? false },
    guildId: opts.guild ?? null,
    content: opts.content ?? 'why is Survivor stuck',
    reply,
    channel: { sendTyping },
  } as never;
  return { message, reply, sendTyping };
}

const answer = (text: string): MediaOutcome => ({ kind: 'answer', result: { answer: text, toolCalls: [{ name: 'trace_request', ok: true }], incomplete: false } });

describe('owner and place gate', () => {
  it.each([
    ['a stranger', { id: '222' }],
    ['a bot', { bot: true }],
    ['a server channel', { guild: '999' }],
    ['an empty message', { content: '   ' }],
  ])('ignores %s without calling the model', async (_n, opts) => {
    const ask = vi.fn();
    const m = msg(opts);
    await createDmHandler({ ownerUserId: OWNER, ask }, CFG)(m.message);
    expect(ask).not.toHaveBeenCalled();
    expect(m.reply).not.toHaveBeenCalled();
  });

  it('answers the owner and names what it read', async () => {
    const ask = vi.fn().mockResolvedValue(answer('Two files are still downloading.'));
    const m = msg();
    await createDmHandler({ ownerUserId: OWNER, ask }, CFG)(m.message);
    expect(m.sendTyping).toHaveBeenCalled();
    expect(m.reply).toHaveBeenCalledTimes(1);
    const text = m.reply.mock.calls[0]![0] as string;
    expect(text).toContain('Two files are still downloading.');
    expect(text).toContain('read: trace_request');
  });
});

describe('failures are said', () => {
  it('says not configured', () => {
    expect(describeOutcome({ kind: 'not-configured' })).toContain('not configured');
  });
  it('says why it failed, and keeps no history of it', async () => {
    const ask = vi.fn().mockResolvedValueOnce({ kind: 'failed', reason: 'lab-agent unreachable (ECONNREFUSED)' }).mockResolvedValueOnce(answer('ok'));
    const h = createDmHandler({ ownerUserId: OWNER, ask }, CFG);
    const a = msg();
    await h(a.message);
    expect(a.reply.mock.calls[0]![0]).toContain('No answer: lab-agent unreachable');
    await h(msg().message);
    expect(ask.mock.calls[1]![1]).toEqual([]);
  });
  it('flags an incomplete or failed-read answer', () => {
    const t = describeOutcome({ kind: 'answer', result: { answer: 'partial', toolCalls: [{ name: 'vpn_health', ok: false }], incomplete: true } });
    expect(t).toContain('incomplete');
    expect(t).toContain('1 read(s) failed');
  });
  it('does not show an empty answer as silence', () => {
    expect(describeOutcome(answer('  '))).toContain('(empty answer)');
  });
});

describe('history', () => {
  it('sends earlier turns, capped, and starts fresh after an idle gap', async () => {
    let t = 0;
    const ask = vi.fn().mockResolvedValue(answer('a'));
    const h = createDmHandler({ ownerUserId: OWNER, ask, now: () => t, idleMs: 1000 }, CFG);
    for (let i = 0; i < 6; i++) await h(msg({ content: `q${i}` }).message);
    expect(ask.mock.calls[5]![1]).toHaveLength(HISTORY_TURNS);
    t = 5000;
    await h(msg({ content: 'later' }).message);
    expect(ask.mock.calls[6]![1]).toEqual([]);
  });

  it('refuses a second question while one is running', async () => {
    let release!: (o: MediaOutcome) => void;
    const ask = vi.fn().mockReturnValue(new Promise<MediaOutcome>((r) => (release = r)));
    const h = createDmHandler({ ownerUserId: OWNER, ask }, CFG);
    const first = msg();
    const p = h(first.message);
    const second = msg();
    await h(second.message);
    expect(second.reply.mock.calls[0]![0]).toContain('Still working');
    expect(ask).toHaveBeenCalledTimes(1);
    release(answer('done'));
    await p;
  });
});

describe('chunk', () => {
  it('keeps short text whole and splits long text at line breaks under the limit', () => {
    expect(chunk('hi')).toEqual(['hi']);
    const long = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    const parts = chunk(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 1900)).toBe(true);
    expect(parts.join('\n').replace(/\n+/g, '\n')).toContain('line 199');
  });
});

describe('askMedia', () => {
  it('is not configured without a token, and makes no request', async () => {
    const f = vi.fn();
    expect(await askMedia('q', [], { ...CFG, token: '' }, f as never)).toEqual({ kind: 'not-configured' });
    expect(f).not.toHaveBeenCalled();
  });
  it('posts the question and history to /v1/media/ask with the bearer', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ answer: 'x', toolCalls: [] }), { status: 200 }));
    const out = await askMedia('q', [{ role: 'user', content: 'p' }], CFG, f as never);
    expect(out.kind).toBe('answer');
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:3016/v1/media/ask');
    expect((init as RequestInit).headers).toMatchObject({ authorization: `Bearer ${CFG.token}` });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ question: 'q', history: [{ role: 'user', content: 'p' }] });
  });
  it.each([
    ['HTTP 404', new Response('{"error":"no such route"}', { status: 404 }), 'HTTP 404: no such route'],
    ['a non-JSON body', new Response('<html>', { status: 200 }), 'not JSON'],
    ['a missing answer', new Response('{}', { status: 200 }), 'without an answer field'],
  ])('reports %s as a failure', async (_n, res, expected) => {
    const f = vi.fn().mockResolvedValue(res);
    const out = await askMedia('q', [], CFG, f as never);
    expect(out.kind).toBe('failed');
    expect((out as { reason: string }).reason).toContain(expected);
  });
  it('reports an unreachable agent', async () => {
    const f = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await askMedia('q', [], CFG, f as never);
    expect((out as { reason: string }).reason).toContain('unreachable (ECONNREFUSED)');
  });
});
