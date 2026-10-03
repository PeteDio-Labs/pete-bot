/**
 * POST /v1/notify — a free-text DM for the owner (PET-579).
 *
 * It has its own bearer (PET-584) and must touch no incident state.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../index.js';
import { reset, size } from '../alertStore.js';

const TOKEN = 'test-notify-token';

function fakeDiscord(sendImpl?: () => Promise<{ id: string }>) {
  const send = vi.fn(sendImpl ?? (async () => ({ id: 'msg-1' })));
  const dm = { id: 'dm-1', send };
  const client = { users: { fetch: vi.fn().mockResolvedValue({ createDM: vi.fn().mockResolvedValue(dm) }) } };
  return { client: client as never, send };
}

const post = (client: never) =>
  request(createApp(client)).post('/v1/notify').set('authorization', `Bearer ${TOKEN}`);

beforeEach(() => reset());

describe('auth', () => {
  it('refuses a request with no bearer', async () => {
    const { client, send } = fakeDiscord();
    await request(createApp(client)).post('/v1/notify').send({ from: 'a', message: 'b' }).expect(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a wrong bearer', async () => {
    const { client, send } = fakeDiscord();
    await request(createApp(client))
      .post('/v1/notify')
      .set('authorization', 'Bearer wrong-token-here')
      .send({ from: 'a', message: 'b' })
      .expect(401);
    expect(send).not.toHaveBeenCalled();
  });

  // PET-584: the alert token stays with Uptime Kuma and opens /v1/alert only.
  it('refuses the alert bearer', async () => {
    const { client, send } = fakeDiscord();
    await request(createApp(client))
      .post('/v1/notify')
      .set('authorization', 'Bearer test-alert-token')
      .send({ from: 'a', message: 'b' })
      .expect(401);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('payload', () => {
  it.each([
    ['no body', {}],
    ['an empty message', { from: 'a', message: '   ' }],
    ['a missing sender', { message: 'b' }],
    ['a sender over 100 characters', { from: 'x'.repeat(101), message: 'b' }],
    ['a message over 1800 characters', { from: 'a', message: 'x'.repeat(1801) }],
    ['a message that is not a string', { from: 'a', message: 42 }],
  ])('rejects %s', async (_name, body) => {
    const { client, send } = fakeDiscord();
    await post(client).send(body).expect(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('ignores unknown keys', async () => {
    const { client } = fakeDiscord();
    await post(client).send({ from: 'a', message: 'b', somethingNew: { nested: true } }).expect(200);
  });
});

describe('delivery', () => {
  it('sends the sender and the message as one DM and returns the ids', async () => {
    const { client, send } = fakeDiscord();
    const res = await post(client).send({ from: 'goofy-skate-cc', message: 'GOOF-18 pilot is done' }).expect(200);
    expect(res.body).toEqual({ ok: true, action: 'sent', channelId: 'dm-1', messageId: 'msg-1' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      content: '**goofy-skate-cc**\nGOOF-18 pilot is done',
      allowedMentions: { parse: [] },
    });
  });

  it('sends a message at the 1800-character limit under Discord’s 2000 cap', async () => {
    const { client, send } = fakeDiscord();
    await post(client).send({ from: 'x'.repeat(100), message: 'y'.repeat(1800) }).expect(200);
    const sent = (send.mock.calls[0] as unknown as [{ content: string }])[0];
    expect(sent.content.length).toBeLessThanOrEqual(2000);
  });

  it('pings no one, whatever the text mentions', async () => {
    const { client, send } = fakeDiscord();
    await post(client).send({ from: 'a', message: '@everyone <@123>' }).expect(200);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [] } }));
  });

  it('touches no incident state', async () => {
    const { client } = fakeDiscord();
    await post(client).send({ from: 'a', message: 'b' }).expect(200);
    expect(size()).toBe(0);
  });

  it('answers 502 when Discord fails, without echoing more than 300 characters', async () => {
    const { client } = fakeDiscord(async () => {
      throw new Error('x'.repeat(500));
    });
    const res = await post(client).send({ from: 'a', message: 'b' }).expect(502);
    expect(res.body.error).toBe('discord delivery failed');
    expect(res.body.detail.length).toBe(300);
  });
});
