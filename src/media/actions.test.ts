/**
 * The media assistant's changes (PET-869): the pending store, the buttons, and what a tap
 * does. The rule under test: a change runs only on the owner's tap, once, within ten minutes.
 */
import { describe, it, expect, vi } from 'bun:test';
import { MessageFlags } from 'discord.js';
import { PendingStore, parseButton, proposalRow, runProposal, PENDING_TTL_MS } from './actions.js';
import { createPresenter } from './present.js';
import { createDmHandler } from './dmHandler.js';
import { actMedia, parseProposals, type MediaOutcome } from '../clients/mediaAgent.js';
import { createInteractionHandler, resultMessage } from '../events/interactionCreate.js';
import { UPDATE_TARGETS } from '../clients/githubActions.js';
import { PROPOSE_TARGETS, type Proposal } from '../lab/tools/propose.js';
import { config } from '../config.js';

const OWNER = '111111111111111111';
// config is shared by every test file in the run, so each test that sets the token restores this one.
const ORIGINAL_TOKEN = config.updates.token;
const CFG = { url: 'http://127.0.0.1:3016', token: 't'.repeat(32), timeoutMs: 1000 };
const subs: Proposal = { action: 'subtitles', kind: 'series', id: 12, title: 'Survivor', label: 'Search subtitles for Survivor (4 missing)', confirm: true };
const apply: Proposal = { action: 'update_apply', target: 'prowlarr', label: 'Install updates for prowlarr', confirm: true };
const check: Proposal = { action: 'update_check', target: 'arr', label: 'Check updates for arr', confirm: false };

describe('constants', () => {
  it('keeps the propose targets equal to the workflow targets', () => {
    expect([...PROPOSE_TARGETS]).toEqual([...UPDATE_TARGETS]);
  });
});

describe('PendingStore', () => {
  it('lets a proposal be taken once', () => {
    const s = new PendingStore();
    const id = s.add(subs);
    expect(s.take(id)).toEqual(subs);
    expect(s.take(id)).toBeUndefined();
  });
  it('expires after ten minutes, and says nothing ran by returning nothing', () => {
    let t = 0;
    const s = new PendingStore(PENDING_TTL_MS, () => t);
    const id = s.add(apply);
    t = PENDING_TTL_MS + 1;
    expect(s.take(id)).toBeUndefined();
  });
  it('drops the oldest past twenty, and ignores an unknown id', () => {
    const s = new PendingStore();
    const first = s.add(subs);
    for (let i = 0; i < 20; i++) s.add(apply);
    expect(s.size).toBe(20);
    expect(s.take(first)).toBeUndefined();
    expect(s.take('0'.repeat(16))).toBeUndefined();
  });
});

describe('buttons', () => {
  it('carry an id and nothing else', () => {
    const json = proposalRow('ab'.repeat(8)).toJSON();
    expect(json.components.map((c) => ('custom_id' in c ? c.custom_id : ''))).toEqual([`media:ok:${'ab'.repeat(8)}`, `media:no:${'ab'.repeat(8)}`]);
  });
  it('parse only the exact shape', () => {
    expect(parseButton(`media:ok:${'0'.repeat(16)}`)).toEqual({ verb: 'ok', id: '0'.repeat(16) });
    for (const bad of ['media:ok:short', 'media:run:' + '0'.repeat(16), 'desk:ok:' + '0'.repeat(16), `media:ok:${'G'.repeat(16)}`]) expect(parseButton(bad)).toBeNull();
  });
});

describe('parseProposals', () => {
  it('keeps well-formed proposals and drops everything else', () => {
    const out = parseProposals([
      subs,
      { action: 'subtitles', kind: 'series', id: '12', title: 'x', label: 'l' },
      { action: 'update_apply', target: 'rm -rf /', label: 'l' },
      { action: 'delete_everything', label: 'l' },
      { ...apply, label: '' },
      apply,
    ]);
    expect(out).toEqual([subs, apply]);
  });
  it('treats a non-array as none', () => {
    expect(parseProposals(undefined)).toEqual([]);
    expect(parseProposals({ action: 'subtitles' })).toEqual([]);
  });
});

describe('actMedia', () => {
  it('posts the kind and id, and returns the message', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, message: 'accepted' }), { status: 200 }));
    expect(await actMedia('series', 12, CFG, f as never)).toEqual({ kind: 'done', message: 'accepted' });
    expect(JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ kind: 'series', id: 12 });
    expect(f.mock.calls[0]![0]).toBe('http://127.0.0.1:3016/v1/media/act');
  });
  it.each<[string, () => ReturnType<typeof actMedia>, 'done' | 'not-configured' | 'failed']>([
    ['not configured', () => actMedia('movie', 1, { ...CFG, token: '' }, vi.fn() as never), 'not-configured'],
    ['a 502', () => actMedia('movie', 1, CFG, (async () => new Response('{"ok":false,"error":"bazarr refused the lab-agent key (HTTP 401)"}', { status: 502 })) as never), 'failed'],
    ['a 404 body', () => actMedia('movie', 1, CFG, (async () => new Response('{"error":"not found"}', { status: 404 })) as never), 'failed'],
    ['an ok without a message', () => actMedia('movie', 1, CFG, (async () => new Response('{"ok":true}', { status: 200 })) as never), 'failed'],
    ['unreachable', () => actMedia('movie', 1, CFG, (async () => { throw new Error('ECONNREFUSED'); }) as never), 'failed'],
  ])('reports %s without claiming success', async (_n, call, kind) => {
    expect((await call()).kind).toBe(kind);
  });
});

describe('runProposal', () => {
  it('runs a subtitle search through lab-agent and names the title', async () => {
    const act = vi.fn().mockResolvedValue({ kind: 'done', message: 'accepted' });
    const r = await runProposal(subs, { act, media: CFG });
    expect(act).toHaveBeenCalledWith('series', 12, CFG);
    expect(r).toEqual({ kind: 'text', ok: true, text: 'Survivor: accepted' });
  });
  it('says a failed search did not run', async () => {
    const r = await runProposal(subs, { act: vi.fn().mockResolvedValue({ kind: 'failed', reason: 'lab-agent unreachable (x)' }), media: CFG });
    expect(r).toMatchObject({ kind: 'text', ok: false });
    expect((r as { text: string }).text).toContain('did not run');
  });
  it('starts apply with force off, for exactly the named target', async () => {
    const update = vi.fn().mockResolvedValue({ kind: 'completed', conclusion: 'success', url: 'u' });
    const r = await runProposal(apply, { update, media: CFG });
    expect(update.mock.calls[0]!.slice(0, 3)).toEqual(['apply', 'prowlarr', false]);
    expect(r.kind).toBe('update');
  });
});

describe('a tap', () => {
  function tap(customId: string, userId = OWNER) {
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const interaction = { isButton: () => true, isChatInputCommand: () => false, customId, user: { id: userId, send }, update, reply, followUp } as never;
    return { interaction, update, reply, followUp, send };
  }

  it('refuses anyone but the owner and runs nothing', async () => {
    const store = new PendingStore();
    const id = store.add(subs);
    const t = tap(`media:ok:${id}`, '999');
    await createInteractionHandler({ mediaPending: store })(t.interaction);
    expect(t.reply).toHaveBeenCalledWith({ content: 'This app answers only the account that installed it.', flags: MessageFlags.Ephemeral });
    expect(store.size).toBe(1);
  });

  it('runs a confirmed update once, removes the buttons first, and a second tap runs nothing', async () => {
    config.updates.token = 'x'.repeat(30);
    try {
      const store = new PendingStore();
      const id = store.add(apply);
      const runUpdate = vi.fn().mockResolvedValue({ kind: 'completed', conclusion: 'success', url: 'https://run', report: 'Updates available: 0' });
      const h = createInteractionHandler({ mediaPending: store, runUpdate });
      const first = tap(`media:ok:${id}`);
      await h(first.interaction);
      expect(first.update).toHaveBeenCalledWith({ content: 'Running: Install updates for prowlarr', components: [] });
      expect(first.update.mock.invocationCallOrder[0]!).toBeLessThan(runUpdate.mock.invocationCallOrder[0]!);
      expect(runUpdate).toHaveBeenCalledTimes(1);
      expect(first.followUp).toHaveBeenCalledTimes(1);
      const second = tap(`media:ok:${id}`);
      await h(second.interaction);
      expect(runUpdate).toHaveBeenCalledTimes(1);
      expect(second.update.mock.calls[0]![0].content).toContain('expired or already ran');
    } finally {
      config.updates.token = ORIGINAL_TOKEN;
    }
  });

  it('cancels without running', async () => {
    const store = new PendingStore();
    const id = store.add(apply);
    const runUpdate = vi.fn();
    const t = tap(`media:no:${id}`);
    await createInteractionHandler({ mediaPending: store, runUpdate })(t.interaction);
    expect(runUpdate).not.toHaveBeenCalled();
    expect(t.update.mock.calls[0]![0].content).toContain('Cancelled');
    expect(store.size).toBe(0);
  });

  it('says an update could not start when its token is missing', async () => {
    config.updates.token = '';
    try {
      const store = new PendingStore();
      const id = store.add(apply);
      const runUpdate = vi.fn();
      const t = tap(`media:ok:${id}`);
      await createInteractionHandler({ mediaPending: store, runUpdate })(t.interaction);
      expect(runUpdate).not.toHaveBeenCalled();
      expect(t.followUp.mock.calls[0]![0].content).toContain('did not run');
    } finally {
      config.updates.token = ORIGINAL_TOKEN;
    }
  });

  it('says a failed run failed', () => {
    expect(resultMessage({ kind: 'text', ok: false, text: 'nope' }).content).toContain('❌');
  });
});

describe('presenting proposals', () => {
  const msg = () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    return { message: { reply } as never, reply };
  };
  it('offers a button for a change and stores it', async () => {
    const store = new PendingStore();
    const m = msg();
    await createPresenter(store, vi.fn() as never)(m.message, [subs]);
    expect(store.size).toBe(1);
    expect(m.reply.mock.calls[0]![0].components).toHaveLength(1);
  });
  it('runs an update check without a button', async () => {
    const store = new PendingStore();
    config.updates.token = 'x'.repeat(30);
    try {
      const run = vi.fn().mockResolvedValue({ kind: 'completed', conclusion: 'success', url: 'u', report: 'Updates available: 0' });
      const m = msg();
      await createPresenter(store, run as never)(m.message, [check]);
      expect(run.mock.calls[0]!.slice(0, 3)).toEqual(['check', 'arr', false]);
      expect(store.size).toBe(0);
    } finally {
      config.updates.token = ORIGINAL_TOKEN;
    }
  });
  it('says so when a check cannot start', async () => {
    const m = msg();
    config.updates.token = '';
    try {
      await createPresenter(new PendingStore(), vi.fn() as never)(m.message, [check]);
      expect(m.reply.mock.calls[0]![0]).toContain('GITHUB_UPDATES_TOKEN');
    } finally {
      config.updates.token = ORIGINAL_TOKEN;
    }
  });
});

describe('the DM handler with proposals', () => {
  const dm = (content = 'get subtitles for Survivor') => {
    const reply = vi.fn().mockResolvedValue(undefined);
    return { message: { author: { id: OWNER, bot: false }, guildId: null, content, reply, channel: { sendTyping: vi.fn().mockResolvedValue(undefined) } } as never, reply };
  };
  const answerWith = (proposals: Proposal[]): MediaOutcome => ({ kind: 'answer', result: { answer: 'I can search for those.', toolCalls: [], proposals, incomplete: false } });

  it('presents proposals after the answer', async () => {
    const present = vi.fn().mockResolvedValue(undefined);
    await createDmHandler({ ownerUserId: OWNER, ask: async () => answerWith([subs]), present }, CFG)(dm().message);
    expect(present).toHaveBeenCalledWith(expect.anything(), [subs]);
  });
  it('says nothing ran when no presenter exists', async () => {
    const m = dm();
    await createDmHandler({ ownerUserId: OWNER, ask: async () => answerWith([subs]) }, CFG)(m.message);
    expect(m.reply.mock.calls.at(-1)![0]).toContain('nothing ran');
  });
  it('says nothing ran when presenting fails', async () => {
    const m = dm();
    await createDmHandler({ ownerUserId: OWNER, ask: async () => answerWith([subs]), present: async () => { throw new Error('boom'); } }, CFG)(m.message);
    expect(m.reply.mock.calls.at(-1)![0]).toContain('nothing ran');
  });
});
