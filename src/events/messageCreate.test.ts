/**
 * Plain DMs. The gating is characterization; the paging, the typing keepalive and the
 * metrics are PET-384 (UC-2, UC-3, UC-4).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChannelType } from 'discord.js';

// vi.mock is hoisted above every import, so the doubles have to be hoisted with it.
const { askMock, healthMock } = vi.hoisted(() => ({ askMock: vi.fn(), healthMock: vi.fn() }));
vi.mock('../clients/mtraceClient.js', () => ({ ask: askMock, health: healthMock }));

import { createMessageHandler } from './messageCreate.js';
import { register } from '../metrics/index.js';

const OWNER = '111111111111111111';

function fakeMessage(over: Record<string, unknown> = {}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const sendTyping = vi.fn().mockResolvedValue(undefined);
  return {
    message: {
      author: { bot: false, id: OWNER },
      channel: { type: ChannelType.DM, sendTyping },
      content: 'is plex up',
      reply,
      ...over,
    } as never,
    reply,
    sendTyping,
  };
}

const handler = () => createMessageHandler({} as never);

beforeEach(() => {
  askMock.mockReset();
  askMock.mockResolvedValue({ text: 'plex is up', routedBy: 'keyword', timing: { totalMs: 120 } });
  register.resetMetrics();
});

describe('who it answers', () => {
  it('ignores another bot', async () => {
    const { message, reply } = fakeMessage({ author: { bot: true, id: OWNER } });
    await handler()(message);
    expect(reply).not.toHaveBeenCalled();
  });

  it('ignores a guild channel', async () => {
    const { message, reply } = fakeMessage({ channel: { type: ChannelType.GuildText, sendTyping: vi.fn() } });
    await handler()(message);
    expect(reply).not.toHaveBeenCalled();
  });

  it('ignores anyone who is not the installer', async () => {
    const { message, reply } = fakeMessage({ author: { bot: false, id: '999' } });
    await handler()(message);
    expect(reply).not.toHaveBeenCalled();
    expect(askMock).not.toHaveBeenCalled();
  });

  it('explains an empty message instead of staying silent', async () => {
    const { message, reply } = fakeMessage({ content: '   ' });
    await handler()(message);
    expect(reply).toHaveBeenCalledOnce();
    expect(String(reply.mock.calls[0]![0])).toMatch(/Message Content/i);
  });
});

describe('answering', () => {
  it('forwards the message as the question', async () => {
    const { message } = fakeMessage({ content: '  why is sonarr stuck  ' });
    await handler()(message);
    expect(askMock).toHaveBeenCalledWith('why is sonarr stuck');
  });

  it('replies with the answer and its footer', async () => {
    const { message, reply } = fakeMessage();
    await handler()(message);
    const [payload] = reply.mock.calls[0]!;
    expect(payload.embeds[0].data.description).toBe('plex is up');
    expect(payload.embeds.at(-1).data.footer.text).toMatch(/routed by keyword/);
  });

  // ── UC-2 ────────────────────────────────────────────────────────────────────
  it('keeps the conclusion of a long answer', async () => {
    askMock.mockResolvedValue({ text: `${'a'.repeat(9000)}THE-CONCLUSION`, routedBy: 'ollama' });
    const { message, reply } = fakeMessage();
    await handler()(message);
    const joined = reply.mock.calls[0]![0].embeds.map((e: { data: { description?: string } }) => e.data.description).join('');
    expect(joined).toContain('THE-CONCLUSION');
    expect(joined).not.toContain('...');
  });

  it('reports the real reason when mtrace fails', async () => {
    askMock.mockRejectedValue(new Error('sonarr is not answering'));
    const { message, reply } = fakeMessage();
    await handler()(message);
    expect(JSON.stringify(reply.mock.calls[0]![0])).toContain('sonarr is not answering');
  });
});

// ── UC-3 ──────────────────────────────────────────────────────────────────────
describe('typing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps typing for the whole of a slow answer', async () => {
    let release!: (v: unknown) => void;
    askMock.mockImplementation(() => new Promise((r) => (release = r)));
    const { message, sendTyping } = fakeMessage();
    const pending = handler()(message);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendTyping.mock.calls.length).toBeGreaterThan(2);

    release({ text: 'done' });
    await pending;
  });
});

// ── UC-4 ──────────────────────────────────────────────────────────────────────
describe('metrics', () => {
  it('counts a successful DM answer', async () => {
    const { message } = fakeMessage();
    await handler()(message);
    const dump = await register.metrics();
    expect(dump).toMatch(/pete_bot_ask_total\{[^}]*surface="dm"[^}]*status="success"[^}]*\} 1/);
  });

  it('counts a failed one separately', async () => {
    askMock.mockRejectedValue(new Error('boom'));
    const { message } = fakeMessage();
    await handler()(message);
    const dump = await register.metrics();
    expect(dump).toMatch(/pete_bot_ask_total\{[^}]*surface="dm"[^}]*status="failure"[^}]*\} 1/);
  });

  it('observes how long the answer took', async () => {
    const { message } = fakeMessage();
    await handler()(message);
    expect(await register.metrics()).toMatch(/pete_bot_ask_duration_seconds_count\{[^}]*surface="dm"[^}]*\} 1/);
  });
});
