/**
 * /ask and /status. The owner gate and the deferred reply are characterization; the
 * paging, the metrics and /status itself are PET-384 (UC-2, UC-4, UC-6).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageFlags } from 'discord.js';

// vi.mock is hoisted above every import, so the doubles have to be hoisted with it.
const { askMock, healthMock } = vi.hoisted(() => ({ askMock: vi.fn(), healthMock: vi.fn() }));
vi.mock('../clients/mtraceClient.js', () => ({ ask: askMock, health: healthMock }));

import { createInteractionHandler } from './interactionCreate.js';
import { register } from '../metrics/index.js';

const OWNER = '111111111111111111';

function fakeInteraction(over: Record<string, unknown> = {}) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'ask',
    user: { id: OWNER },
    options: { getString: vi.fn().mockReturnValue('is plex up') },
    deferReply,
    editReply,
    reply,
    ...over,
  } as never;
  return { interaction, deferReply, editReply, reply };
}

const handler = () => createInteractionHandler();

beforeEach(() => {
  askMock.mockReset();
  askMock.mockResolvedValue({ text: 'plex is up', routedBy: 'keyword', timing: { totalMs: 120 } });
  healthMock.mockReset();
  healthMock.mockResolvedValue({ reachable: true, service: 'mtrace', model: 'qwen2.5:7b' });
  register.resetMetrics();
});

describe('who it answers', () => {
  it('refuses anyone but the installer', async () => {
    const { interaction, reply, deferReply } = fakeInteraction({ user: { id: '999' } });
    await handler()(interaction);
    expect(reply).toHaveBeenCalledOnce();
    expect(deferReply).not.toHaveBeenCalled();
    expect(askMock).not.toHaveBeenCalled();
  });

  it('ignores an interaction that is not a slash command', async () => {
    const { interaction, reply } = fakeInteraction({ isChatInputCommand: () => false });
    await handler()(interaction);
    expect(reply).not.toHaveBeenCalled();
  });
});

describe('/ask', () => {
  it('defers before the slow work, and keeps it ephemeral', async () => {
    const { interaction, deferReply } = fakeInteraction();
    await handler()(interaction);
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(deferReply.mock.invocationCallOrder[0]!).toBeLessThan(askMock.mock.invocationCallOrder[0]!);
  });

  it('answers with the embed and its footer', async () => {
    const { interaction, editReply } = fakeInteraction();
    await handler()(interaction);
    const [payload] = editReply.mock.calls[0]!;
    expect(payload.embeds[0].data.description).toBe('plex is up');
    expect(payload.embeds.at(-1).data.footer.text).toMatch(/routed by keyword/);
  });

  // ── UC-2 ────────────────────────────────────────────────────────────────────
  it('keeps the conclusion of a long answer', async () => {
    askMock.mockResolvedValue({ text: `${'b'.repeat(9000)}THE-CONCLUSION`, routedBy: 'ollama' });
    const { interaction, editReply } = fakeInteraction();
    await handler()(interaction);
    const joined = editReply.mock.calls
      .flatMap((c) => c[0].embeds as { data: { description?: string } }[])
      .map((e) => e.data.description)
      .join('');
    expect(joined).toContain('THE-CONCLUSION');
  });

  it('reports the real reason when mtrace fails', async () => {
    askMock.mockRejectedValue(new Error('mtrace returned 401'));
    const { interaction, editReply } = fakeInteraction();
    await handler()(interaction);
    expect(JSON.stringify(editReply.mock.calls[0]![0])).toContain('401');
  });
});

// ── UC-6 ──────────────────────────────────────────────────────────────────────
describe('/status', () => {
  it('reports mtrace reachable without asking it a question', async () => {
    const { interaction, editReply } = fakeInteraction({ commandName: 'status' });
    await handler()(interaction);
    expect(healthMock).toHaveBeenCalled();
    expect(askMock).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls[0]![0])).toMatch(/mtrace/i);
  });

  it('says so plainly when mtrace is unreachable', async () => {
    healthMock.mockResolvedValue({ reachable: false, detail: 'connect ECONNREFUSED 127.0.0.1:8237' });
    const { interaction, editReply } = fakeInteraction({ commandName: 'status' });
    await handler()(interaction);
    const dump = JSON.stringify(editReply.mock.calls[0]![0]);
    expect(dump).toContain('ECONNREFUSED');
    expect(dump).toMatch(/unreachable|down/i);
  });

  it('reports how many alert batches it is holding', async () => {
    const { interaction, editReply } = fakeInteraction({ commandName: 'status' });
    await handler()(interaction);
    expect(JSON.stringify(editReply.mock.calls[0]![0])).toMatch(/alert/i);
  });

  it('refuses /status from anyone but the installer too', async () => {
    const { interaction, reply } = fakeInteraction({ commandName: 'status', user: { id: '999' } });
    await handler()(interaction);
    expect(reply).toHaveBeenCalledOnce();
    expect(healthMock).not.toHaveBeenCalled();
  });
});

// ── UC-4 ──────────────────────────────────────────────────────────────────────
describe('metrics', () => {
  it('counts a successful /ask under its own surface', async () => {
    const { interaction } = fakeInteraction();
    await handler()(interaction);
    const dump = await register.metrics();
    expect(dump).toMatch(/pete_bot_ask_total\{[^}]*surface="ask"[^}]*status="success"[^}]*\} 1/);
  });

  it('counts a failure', async () => {
    askMock.mockRejectedValue(new Error('boom'));
    const { interaction } = fakeInteraction();
    await handler()(interaction);
    expect(await register.metrics()).toMatch(/pete_bot_ask_total\{[^}]*surface="ask"[^}]*status="failure"[^}]*\} 1/);
  });

  it('counts a refusal, so an app answering nobody is visible', async () => {
    const { interaction } = fakeInteraction({ user: { id: '999' } });
    await handler()(interaction);
    expect(await register.metrics()).toMatch(/pete_bot_ask_total\{[^}]*status="refused"[^}]*\} 1/);
  });
});
