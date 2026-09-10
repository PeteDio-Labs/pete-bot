/**
 * POST /v1/alert — the path Uptime Kuma's 19 monitors now depend on.
 *
 * Auth and schema are characterization: they ship today and must not move. The
 * send-once-then-edit behaviour is PET-384 (UC-1, UC-7).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../index.js';
import { reset } from '../alertStore.js';

const TOKEN = 'test-alert-token';

function fakeDiscord() {
  const edit = vi.fn().mockResolvedValue(undefined);
  const messages = { fetch: vi.fn().mockResolvedValue({ edit }) };
  const send = vi.fn(async () => ({ id: `msg-${send.mock.calls.length}` }));
  const dm = { id: 'dm-1', send, messages };
  const client = { users: { fetch: vi.fn().mockResolvedValue({ createDM: vi.fn().mockResolvedValue(dm) }) } };
  return { client: client as never, send, edit, messages };
}

const downPayload = (name: string, msg = 'connect ECONNREFUSED') => ({
  heartbeat: { status: 0, msg, time: '2026-09-10 04:00:00' },
  monitor: { name },
});
const upPayload = (name: string) => ({ heartbeat: { status: 1, msg: 'OK', time: '2026-09-10 04:05:00' }, monitor: { name } });

beforeEach(() => reset());

describe('auth', () => {
  it('refuses a request with no bearer', async () => {
    const { client } = fakeDiscord();
    await request(createApp(client)).post('/v1/alert').send(downPayload('vault')).expect(401);
  });

  it('refuses a wrong bearer', async () => {
    const { client, send } = fakeDiscord();
    await request(createApp(client))
      .post('/v1/alert')
      .set('authorization', 'Bearer wrong-token-here')
      .send(downPayload('vault'))
      .expect(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts the configured bearer', async () => {
    const { client } = fakeDiscord();
    await request(createApp(client))
      .post('/v1/alert')
      .set('authorization', `Bearer ${TOKEN}`)
      .send(downPayload('vault'))
      .expect(200);
  });
});

describe('payload', () => {
  it('rejects a monitor name that is not a string', async () => {
    const { client } = fakeDiscord();
    await request(createApp(client))
      .post('/v1/alert')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ monitor: { name: 42 } })
      .expect(400);
  });

  it('ignores unknown keys so a Kuma upgrade cannot break alerting', async () => {
    const { client } = fakeDiscord();
    await request(createApp(client))
      .post('/v1/alert')
      .set('authorization', `Bearer ${TOKEN}`)
      .send({ ...downPayload('vault'), somethingNew: { nested: true } })
      .expect(200);
  });
});

describe('a monitor that goes down', () => {
  it('sends one DM', async () => {
    const { client, send } = fakeDiscord();
    const res = await request(createApp(client))
      .post('/v1/alert')
      .set('authorization', `Bearer ${TOKEN}`)
      .send(downPayload('vault'))
      .expect(200);
    expect(res.body).toMatchObject({ ok: true, action: 'sent' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  // ── UC-1 ────────────────────────────────────────────────────────────────────
  it('edits rather than sending a second DM when it is still down', async () => {
    const { client, send, edit } = fakeDiscord();
    const app = createApp(client);
    const post = (body: unknown) =>
      request(app).post('/v1/alert').set('authorization', `Bearer ${TOKEN}`).send(body as object);

    await post(downPayload('vault')).expect(200);
    const second = await post(downPayload('vault')).expect(200);

    expect(second.body).toMatchObject({ action: 'edited' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it('survives Kuma resending the same heartbeat twenty times', async () => {
    const { client, send } = fakeDiscord();
    const app = createApp(client);
    for (let i = 0; i < 20; i++) {
      await request(app).post('/v1/alert').set('authorization', `Bearer ${TOKEN}`).send(downPayload('vault')).expect(200);
    }
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('says how long it has been down once it has seen more than one beat', async () => {
    const { client, edit } = fakeDiscord();
    const app = createApp(client);
    const post = () => request(app).post('/v1/alert').set('authorization', `Bearer ${TOKEN}`).send(downPayload('vault'));
    await post();
    await post();
    const embed = edit.mock.calls[0]![0].embeds[0];
    expect(JSON.stringify(embed)).toMatch(/2 checks|down for/i);
  });
});

// ── UC-7 ──────────────────────────────────────────────────────────────────────
describe('a storm', () => {
  it('puts a node reboot in one DM, not nineteen', async () => {
    const { client, send, edit } = fakeDiscord();
    const app = createApp(client);
    const monitors = ['vault', 'zot', 'plex', 'sonarr', 'radarr', 'lidarr', 'seerr', 'qbit'];
    for (const m of monitors) {
      await request(app).post('/v1/alert').set('authorization', `Bearer ${TOKEN}`).send(downPayload(m)).expect(200);
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(monitors.length - 1);
  });

  it('names every monitor in the rolled-up message', async () => {
    const { client, edit } = fakeDiscord();
    const app = createApp(client);
    for (const m of ['vault', 'zot', 'plex']) {
      await request(app).post('/v1/alert').set('authorization', `Bearer ${TOKEN}`).send(downPayload(m)).expect(200);
    }
    const last = JSON.stringify(edit.mock.calls.at(-1)![0]);
    expect(last).toContain('vault');
    expect(last).toContain('zot');
    expect(last).toContain('plex');
  });
});

describe('recovery', () => {
  it('edits the original message rather than posting a second one', async () => {
    const { client, send, edit } = fakeDiscord();
    const app = createApp(client);
    await request(app).post('/v1/alert').set('authorization', `Bearer ${TOKEN}`).send(downPayload('vault')).expect(200);
    const res = await request(app).post('/v1/alert').set('authorization', `Bearer ${TOKEN}`).send(upPayload('vault')).expect(200);

    expect(res.body).toMatchObject({ action: 'edited' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it('posts a standalone message for a recovery it never saw fail', async () => {
    const { client, send } = fakeDiscord();
    const res = await request(createApp(client))
      .post('/v1/alert')
      .set('authorization', `Bearer ${TOKEN}`)
      .send(upPayload('mystery'))
      .expect(200);
    expect(res.body).toMatchObject({ action: 'sent' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('when Discord refuses', () => {
  it('answers 502 with the reason instead of swallowing it', async () => {
    const client = {
      users: { fetch: vi.fn().mockRejectedValue(new Error('50007: Cannot send messages to this user')) },
    } as never;
    const res = await request(createApp(client))
      .post('/v1/alert')
      .set('authorization', `Bearer ${TOKEN}`)
      .send(downPayload('vault'))
      .expect(502);
    expect(res.body.detail).toContain('50007');
  });

  it('does not record a message it failed to send', async () => {
    const client = { users: { fetch: vi.fn().mockRejectedValue(new Error('50007')) } } as never;
    const app = createApp(client);
    await request(app).post('/v1/alert').set('authorization', `Bearer ${TOKEN}`).send(downPayload('vault')).expect(502);

    const { client: good, send } = fakeDiscord();
    await request(createApp(good)).post('/v1/alert').set('authorization', `Bearer ${TOKEN}`).send(downPayload('vault')).expect(200);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('health', () => {
  it('answers without auth and reports what it is holding', async () => {
    const { client } = fakeDiscord();
    const res = await request(createApp(client)).get('/health').expect(200);
    expect(res.body).toMatchObject({ ok: true, service: 'pete-bot-http' });
    expect(res.body).toHaveProperty('alertBatches');
  });

  it('404s an unknown path as JSON', async () => {
    const { client } = fakeDiscord();
    await request(createApp(client)).get('/nope').expect(404).expect('Content-Type', /json/);
  });
});
