import { describe, expect, test } from 'bun:test';
import { ollamaTriager, parseTriage, triageNote, triagerFromEnv } from './triage.js';

const reply = (content: string) => (async () => new Response(JSON.stringify({ message: { content } }))) as unknown as typeof fetch;

describe('parseTriage', () => {
  test('reads the three fields', () => {
    expect(parseTriage('{"act":true,"why":"vzdump failed","step":"Rerun the backup"}')).toEqual({ act: true, why: 'vzdump failed', step: 'Rerun the backup' });
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
    expect(triageNote({ act: true, why: 'disk full', step: 'Free space on 244' })).toContain('Needs you');
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
