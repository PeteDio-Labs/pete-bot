import { describe, expect, test } from 'bun:test';
import { clampTimeout, limited, ollamaTriager, parseTriage, plain, triageNote, triagerFromEnv } from './triage.js';

const reply = (content: string) => (async () => new Response(JSON.stringify({ message: { content } }))) as unknown as typeof fetch;

describe('parseTriage', () => {
  test('reads the three fields', () => {
    expect(parseTriage('{"act":true,"why":"vzdump failed","step":"The backup needs another run"}')).toEqual({ act: true, why: 'vzdump failed', step: 'The backup needs another run' });
  });
  test('strips think blocks and surrounding text', () => {
    expect(parseTriage('<think>x</think> ok {"act":false,"why":"blip","step":""} done')?.act).toBe(false);
  });
  test.each(['', 'not json', '{"act":"yes","why":"a","step":"b"}', '{"act":true,"why":"a","step":""}', '{"act":true,"step":"b"}', '[]'])('rejects %p', (s) => {
    expect(parseTriage(s)).toBeNull();
  });
  test('caps long fields', () => {
    expect(parseTriage(JSON.stringify({ act: true, why: 'w'.repeat(900), step: 's' }))?.why.length).toBe(200);
  });
});

describe('triageNote', () => {
  test('adds a line only when action is needed', () => {
    expect(triageNote({ act: true, why: 'disk full', step: 'Free space is low on 244' })).toContain('unverified');
    expect(triageNote({ act: false, why: 'blip', step: '' })).toBeUndefined();
    expect(triageNote(null)).toBeUndefined();
  });
});

describe('ollamaTriager', () => {
  const s = { url: 'http://x', model: 'm', timeoutMs: 100 };
  test('returns a parsed result', async () => {
    const t = ollamaTriager(s, reply('{"act":true,"why":"a","step":"b"}'));
    expect((await t({ monitor: 'm', detail: 'd' }))?.step).toBe('b');
  });
  test('returns null for an off-format reply', async () => {
    expect(await ollamaTriager(s, reply('sorry'))({ monitor: 'm', detail: '' })).toBeNull();
  });
  test('throws on an HTTP error so the caller logs it', async () => {
    const f = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch;
    await expect(ollamaTriager(s, f)({ monitor: 'm', detail: '' })).rejects.toThrow('500');
  });
});

describe('triagerFromEnv', () => {
  test('is off with no URL or a bad one', () => {
    expect(triagerFromEnv({})).toBeNull();
    expect(triagerFromEnv({ TRIAGE_OLLAMA_URL: 'nope' })).toBeNull();
  });
  test('is on with a URL', () => {
    expect(triagerFromEnv({ TRIAGE_OLLAMA_URL: 'http://192.168.50.246:11434' })).not.toBeNull();
  });
});

describe('untrusted text', () => {
  test('plain removes links, mentions and markdown', () => {
    expect(plain('a url https://example.test, a mention @everyone, `code`, [label](target) and **bold** appear')).toBe('a url link removed a mention everyone, code, labeltarget and bold appear');
  });
  test('a parsed step carries no link or mention', () => {
    const r = parseTriage(JSON.stringify({ act: true, why: 'a url https://x.test is present', step: 'a mention of @here appears' }));
    expect(r?.why).toBe('a url link removed is present');
    expect(r?.step).not.toContain('@');
  });
  test('the note is framed as an unverified suggestion', () => {
    expect(triageNote({ act: true, why: 'a', step: 'b' })).toContain('unverified');
  });
});

describe('limits', () => {
  test('clampTimeout falls back for a bad value', () => {
    expect(clampTimeout('-1')).toBe(4000);
    expect(clampTimeout('999999')).toBe(4000);
    expect(clampTimeout('abc')).toBe(4000);
    expect(clampTimeout('2500')).toBe(2500);
    expect(clampTimeout(undefined)).toBe(4000);
  });
  test('a call over the concurrency limit is skipped, not queued', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const t = limited(async () => { await gate; return { act: true, why: 'a', step: 'b' }; }, 1);
    const first = t({ monitor: 'a', detail: '' });
    expect(await t({ monitor: 'b', detail: '' })).toBeNull();
    release();
    expect((await first)?.step).toBe('b');
  });
});
