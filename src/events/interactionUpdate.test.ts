/**
 * /update (PET-395): the owner gate, the deferral, and every way a run can end — a
 * report, a failure, a run that never appeared, a run that outlived the reply, and a host
 * with no token.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageFlags } from 'discord.js';

const { runUpdateMock } = vi.hoisted(() => ({ runUpdateMock: vi.fn() }));
vi.mock('../clients/githubActions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../clients/githubActions.js')>()),
  runUpdate: runUpdateMock,
}));
vi.mock('../clients/mtraceClient.js', () => ({ ask: vi.fn(), health: vi.fn() }));

import { createInteractionHandler } from './interactionCreate.js';
import { config } from '../config.js';
import { register } from '../metrics/index.js';

const OWNER = '111111111111111111';
const COLOR_OK = 0x57f287;
const COLOR_WARN = 0xfee75c;
const COLOR_ERR = 0xed4245;
const REPORT = ' MEDIA STACK — UPDATE CHECK\nplex   1.43.4   —   apt\n Updates available: 0';

function fakeUpdate(opts: { sub?: string; target?: string | null; force?: boolean | null; user?: string } = {}) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const reply = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    isChatInputCommand: () => true,
    commandName: 'update',
    user: { id: opts.user ?? OWNER, send },
    options: {
      getSubcommand: vi.fn().mockReturnValue(opts.sub ?? 'check'),
      getString: vi.fn().mockReturnValue(opts.target === undefined ? 'plex' : opts.target),
      getBoolean: vi.fn().mockReturnValue(opts.force ?? null),
    },
    deferReply,
    editReply,
    reply,
  } as never;
  return { interaction, deferReply, editReply, reply, send };
}

const lastEmbed = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)![0].embeds[0].data;
const handle = (interaction: never) => createInteractionHandler()(interaction);

beforeEach(() => {
  runUpdateMock.mockReset();
  runUpdateMock.mockResolvedValue({ kind: 'completed', conclusion: 'success', url: 'https://run/1', report: REPORT });
  register.resetMetrics();
});

describe('/update — who and how', () => {
  it('refuses anyone but the installer, and starts nothing', async () => {
    const { interaction, reply } = fakeUpdate({ user: '999' });
    await handle(interaction);
    expect(reply).toHaveBeenCalledOnce();
    expect(runUpdateMock).not.toHaveBeenCalled();
  });

  it('defers before starting a run, and keeps it ephemeral', async () => {
    const { interaction, deferReply } = fakeUpdate();
    await handle(interaction);
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(deferReply.mock.invocationCallOrder[0]!).toBeLessThan(runUpdateMock.mock.invocationCallOrder[0]!);
  });

  it('passes the mode, the target and force through', async () => {
    const { interaction } = fakeUpdate({ sub: 'apply', target: 'plex', force: true });
    await handle(interaction);
    expect(runUpdateMock).toHaveBeenCalledWith('apply', 'plex', true, expect.any(Object));
  });

  it('never forces a check', async () => {
    const { interaction } = fakeUpdate({ sub: 'check', force: true });
    await handle(interaction);
    expect(runUpdateMock).toHaveBeenCalledWith('check', 'plex', false, expect.any(Object));
  });

  it('checks Plex and the *arr apps when no target is given', async () => {
    const { interaction } = fakeUpdate({ target: null });
    await handle(interaction);
    expect(runUpdateMock).toHaveBeenCalledWith('check', 'plex-and-arr', false, expect.any(Object));
  });

  it('says it is not configured, without starting anything, when the token is empty', async () => {
    const saved = config.updates.token;
    config.updates.token = '';
    try {
      const { interaction, editReply } = fakeUpdate();
      await handle(interaction);
      expect(runUpdateMock).not.toHaveBeenCalled();
      expect(lastEmbed(editReply).title).toMatch(/not configured/);
    } finally {
      config.updates.token = saved;
    }
  });
});

describe('/update — how a run ends', () => {
  it('shows the report in a code block with the run link, green when nothing is left', async () => {
    const { interaction, editReply } = fakeUpdate();
    await handle(interaction);
    const embed = lastEmbed(editReply);
    expect(embed.title).toBe('/update check plex');
    expect(embed.description).toContain('```\n MEDIA STACK');
    expect(embed.description).toContain('(https://run/1)');
    expect(embed.color).toBe(COLOR_OK);
  });

  it('turns yellow when an update is available or a service skipped itself', async () => {
    runUpdateMock.mockResolvedValue({
      kind: 'completed',
      conclusion: 'success',
      url: 'https://run/1',
      report: `${REPORT}\n NOTE plex: update skipped, 1 active playback session(s)`,
    });
    const { interaction, editReply } = fakeUpdate({ sub: 'apply' });
    await handle(interaction);
    expect(lastEmbed(editReply).color).toBe(COLOR_WARN);
  });

  it('reports a failed run in red, with its conclusion in the title', async () => {
    runUpdateMock.mockResolvedValue({ kind: 'completed', conclusion: 'failure', url: 'https://run/1' });
    const { interaction, editReply } = fakeUpdate({ sub: 'apply' });
    await handle(interaction);
    const embed = lastEmbed(editReply);
    expect(embed.title).toBe('/update apply plex: failure');
    expect(embed.color).toBe(COLOR_ERR);
  });

  it('says a run that never appeared never appeared', async () => {
    runUpdateMock.mockResolvedValue({ kind: 'not-found', requestId: 'pb-t', url: 'https://runs' });
    const { interaction, editReply } = fakeUpdate();
    await handle(interaction);
    const embed = lastEmbed(editReply);
    expect(embed.title).toMatch(/never appeared/);
    expect(embed.description).toContain('pb-t');
    expect(embed.color).toBe(COLOR_ERR);
  });

  it('reports a dispatch GitHub refused, with GitHub\'s answer', async () => {
    runUpdateMock.mockRejectedValue(new Error('Starting the update failed: GitHub answered HTTP 403'));
    const { interaction, editReply } = fakeUpdate();
    await handle(interaction);
    const embed = lastEmbed(editReply);
    expect(embed.title).toBe('/update check plex failed');
    expect(embed.description).toContain('HTTP 403');
  });

  it('DMs the result once the reply can no longer be edited', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      runUpdateMock.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 20 * 60_000);
        return { kind: 'completed', conclusion: 'success', url: 'https://run/1', report: REPORT };
      });
      const { interaction, editReply, send } = fakeUpdate({ sub: 'apply' });
      await handle(interaction);
      expect(send).toHaveBeenCalledOnce();
      expect(editReply).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
