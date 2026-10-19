/**
 * /status and the owner gate. The gate and the deferred reply are characterization; the
 * metrics are PET-384 (UC-4, UC-6). /ask went in PET-518, and /update has its own file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import { MessageFlags } from 'discord.js';
import { createInteractionHandler } from './interactionCreate.js';
import { config } from '../config.js';
import { register } from '../metrics/index.js';

const OWNER = '111111111111111111';

function fakeInteraction(over: Record<string, unknown> = {}) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'status',
    user: { id: OWNER },
    deferReply,
    editReply,
    reply,
    ...over,
  } as never;
  return { interaction, deferReply, editReply, reply };
}

const handler = () => createInteractionHandler();
const fetchMock = vi.fn();
const realFetch = globalThis.fetch;
const originalToken = config.updates.token;

beforeEach(() => {
  register.resetMetrics();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  config.updates.token = originalToken;
});

describe('who it answers', () => {
  it('refuses anyone but the installer', async () => {
    const { interaction, reply, deferReply } = fakeInteraction({ user: { id: '999' } });
    await handler()(interaction);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(deferReply).not.toHaveBeenCalled();
  });

  it('ignores an interaction that is not a slash command', async () => {
    const { interaction, reply } = fakeInteraction({ isChatInputCommand: () => false });
    await handler()(interaction);
    expect(reply).not.toHaveBeenCalled();
  });

  // PET-518. A client that still has /ask cached can send it until Discord refreshes the
  // command list. It must get no answer and cause no call to anything.
  it('does nothing with a stale /ask', async () => {
    const { interaction, reply, deferReply, editReply } = fakeInteraction({ commandName: 'ask' });
    await handler()(interaction);
    expect(deferReply).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── UC-6 ──────────────────────────────────────────────────────────────────────
describe('/status', () => {
  it('defers, stays ephemeral, and calls nothing over the network', async () => {
    const { interaction, deferReply } = fakeInteraction();
    await handler()(interaction);
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports how many alert batches it is holding', async () => {
    const { interaction, editReply } = fakeInteraction();
    await handler()(interaction);
    expect(JSON.stringify(editReply.mock.calls[0]![0])).toMatch(/0 incidents open/);
  });

  it('no longer mentions mtrace', async () => {
    const { interaction, editReply } = fakeInteraction();
    await handler()(interaction);
    expect(JSON.stringify(editReply.mock.calls[0]![0])).not.toMatch(/mtrace/i);
  });

  it('says when /update has no token', async () => {
    config.updates.token = '';
    const { interaction, editReply } = fakeInteraction();
    await handler()(interaction);
    expect(JSON.stringify(editReply.mock.calls[0]![0])).toMatch(/not configured/);
  });

  it('refuses /status from anyone but the installer too', async () => {
    const { interaction, reply, deferReply } = fakeInteraction({ user: { id: '999' } });
    await handler()(interaction);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(deferReply).not.toHaveBeenCalled();
  });
});

// ── UC-4 ──────────────────────────────────────────────────────────────────────
describe('metrics', () => {
  it('counts a refusal under the refused command, so an app answering nobody is visible', async () => {
    const { interaction } = fakeInteraction({ user: { id: '999' } });
    await handler()(interaction);
    expect(await register.metrics()).toMatch(
      /pete_bot_ask_total\{[^}]*surface="status"[^}]*status="refused"[^}]*\} 1/,
    );
  });
});

// PET-645. A merge desk button is checked against the owner before the desk sees it.
describe('merge desk buttons', () => {
  function button(userId: string) {
    const reply = vi.fn().mockResolvedValue(undefined);
    const deferReply = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      isButton: () => true,
      isChatInputCommand: () => false,
      customId: `desk:merge:petedio-vault:3:${'a'.repeat(40)}`,
      user: { id: userId },
      reply,
      deferReply,
      editReply,
    } as never;
    return { interaction, reply, editReply };
  }

  it('refuses anyone but the owner, without asking the desk', async () => {
    const tap = vi.fn();
    const { interaction, reply } = button('999');
    await createInteractionHandler({ desk: () => ({ tap }) as never })(interaction);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(tap).not.toHaveBeenCalled();
  });

  it("passes the owner's tap to the desk and shows its answer", async () => {
    const tap = vi.fn().mockResolvedValue('Merged as mmmmmmm on `main`.');
    const { interaction, editReply } = button(OWNER);
    await createInteractionHandler({ desk: () => ({ tap }) as never })(interaction);
    expect(tap).toHaveBeenCalledWith(`desk:merge:petedio-vault:3:${'a'.repeat(40)}`);
    expect(editReply).toHaveBeenCalledWith({ content: 'Merged as mmmmmmm on `main`.' });
  });

  it('says the desk is off when it is', async () => {
    const { interaction, editReply } = button(OWNER);
    await createInteractionHandler({ desk: () => null })(interaction);
    expect(editReply.mock.calls[0]![0].content).toContain('merge desk is off');
  });
});
