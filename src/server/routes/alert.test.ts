/**
 * POST /v1/alert — the path Uptime Kuma's 19 monitors now depend on.
 *
 * Auth and schema are characterization: they ship today and must not move. The
 * send-once-then-edit behaviour is PET-384 (UC-1, UC-7).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import request from 'supertest';
import { createApp } from '../index.js';
import { reset, heldCount, activeBatches } from '../alertStore.js';
import { config } from '../../config.js';
import { parseWindows } from '../decider.js';
import { resetBaseline } from '../baseline.js';

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

  // PET-584: sessions on claude-247 and codex-248 hold the notify token, and must not be
  // able to post a fake DOWN with it.
  it('refuses the notify bearer', async () => {
    const { client, send } = fakeDiscord();
    await request(createApp(client))
      .post('/v1/alert')
      .set('authorization', 'Bearer test-notify-token')
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

// ── PET-436: the 2026-09-15 shape ────────────────────────────────────────────
describe('recoveries whose outage was never seen', () => {
  it('sends exactly one DM when some DOWNs were lost and every UP arrives', async () => {
    const { client, send, edit } = fakeDiscord();
    const app = createApp(client);
    const post = (body: unknown) => request(app).post('/v1/alert').set('authorization', `Bearer ${TOKEN}`).send(body as object);

    // dns-router and vault went down and were seen. radarr and prowlarr went down unseen.
    await post(downPayload('dns-router')).expect(200);
    await post(downPayload('vault')).expect(200);
    await post(upPayload('radarr')).expect(200);
    await post(upPayload('prowlarr')).expect(200);
    await post(upPayload('dns-router')).expect(200);
    await post(upPayload('vault')).expect(200);

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(5);
  });

  it('sends one message for a burst of orphans with no incident open', async () => {
    const { client, send, edit } = fakeDiscord();
    const app = createApp(client);
    const post = (body: unknown) => request(app).post('/v1/alert').set('authorization', `Bearer ${TOKEN}`).send(body as object);

    await post(upPayload('radarr')).expect(200);
    await post(upPayload('prowlarr')).expect(200);
    await post(upPayload('pve02')).expect(200);

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(2);
  });
});

// ── PET-492: a DOWN inside the backup window ─────────────────────────────────
describe('a maintenance window', () => {
  const originalWindows = config.alerts.maintenanceWindows;
  const originalDeadline = config.alerts.maintenanceDeadlineMs;
  const at = (iso: string, status: 0 | 1, name: string) => ({
    heartbeat: { status, msg: status ? 'OK' : 'timeout', time: iso },
    monitor: { name },
  });

  beforeEach(() => {
    config.alerts.maintenanceWindows = parseWindows('America/New_York 02:45 30');
    config.alerts.maintenanceDeadlineMs = 300_000;
    config.alerts.baselinePath = '';
    resetBaseline();
  });

  afterEach(() => {
    config.alerts.maintenanceWindows = originalWindows;
    config.alerts.maintenanceDeadlineMs = originalDeadline;
    reset();
  });

  function setup() {
    const d = fakeDiscord();
    const app = createApp(d.client);
    const post = (body: unknown) => request(app).post('/v1/alert').set('authorization', `Bearer ${TOKEN}`).send(body as object);
    return { ...d, post };
  }

  it('holds a DOWN and sends no DM, then releases it on the UP', async () => {
    const { post, send } = setup();
    const down = await post(at('2026-09-23 06:47:00', 0, 'vault')).expect(200);
    expect(down.body).toMatchObject({ action: 'held' });
    expect(heldCount()).toBe(1);

    const up = await post(at('2026-09-23 06:47:30', 1, 'vault')).expect(200);
    expect(up.body).toMatchObject({ action: 'released' });
    expect(heldCount()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a DOWN outside the window and closes it on the UP', async () => {
    const { post, send } = setup();
    const down = await post(at('2026-09-23 14:00:00', 0, 'vault')).expect(200);
    expect(down.body).toMatchObject({ action: 'sent' });
    const up = await post(at('2026-09-23 14:00:30', 1, 'vault')).expect(200);
    expect(up.body).toMatchObject({ action: 'edited' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('holds a repeated DOWN once', async () => {
    const { post, send } = setup();
    await post(at('2026-09-23 06:47:00', 0, 'vault')).expect(200);
    const again = await post(at('2026-09-23 06:47:20', 0, 'vault')).expect(200);
    expect(again.body).toMatchObject({ action: 'held' });
    expect(heldCount()).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the DM with the window and the passed deadline when the UP never comes', async () => {
    config.alerts.maintenanceDeadlineMs = 30;
    const { post, send } = setup();
    await post(at('2026-09-23 06:47:00', 0, 'vault')).expect(200);
    await new Promise((r) => setTimeout(r, 120));

    expect(heldCount()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    const body = JSON.stringify(send.mock.calls[0]);
    expect(body).toContain('America/New_York 02:45');
    expect(body).toContain('deadline');
  });

  it('does not train the deadline from a recovery that missed it', async () => {
    config.alerts.maintenanceDeadlineMs = 30;
    const { post } = setup();
    await post(at('2026-09-23 06:47:00', 0, 'vault')).expect(200);
    await new Promise((r) => setTimeout(r, 120));
    const up = await post(at('2026-09-23 06:50:00', 1, 'vault')).expect(200);
    expect(up.body).toMatchObject({ action: 'edited' });
    const { stats } = await import('../baseline.js');
    expect(stats('vault')).toBeNull();
  });

  it('does not hold a monitor already in an open incident', async () => {
    const { post, send } = setup();
    await post(at('2026-09-23 14:00:00', 0, 'vault')).expect(200);
    const again = await post(at('2026-09-23 06:47:00', 0, 'vault')).expect(200);
    expect(again.body).toMatchObject({ action: 'edited' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends at once on restart when a persisted hold already passed its deadline', async () => {
    const { addHold } = await import('../alertStore.js');
    addHold({ monitor: 'plane', since: Date.now() - 600_000, deadlineAt: Date.now() - 1000, window: 'w', detail: 'timeout' });
    const { send } = setup();
    await new Promise((r) => setTimeout(r, 50));
    expect(heldCount()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

// ── PET-492: a held DOWN must survive Discord being unavailable ──────────────
describe('a held DOWN when Discord is unavailable', () => {
  const originalWindows = config.alerts.maintenanceWindows;
  const originalDeadline = config.alerts.maintenanceDeadlineMs;
  const inWindow = (status: 0 | 1, name: string) => ({
    heartbeat: { status, msg: 'timeout', time: '2026-09-23 06:47:00' },
    monitor: { name },
  });

  beforeEach(() => {
    config.alerts.maintenanceWindows = parseWindows('America/New_York 02:45 30');
    config.alerts.maintenanceDeadlineMs = 300_000;
    config.alerts.baselinePath = '';
    resetBaseline();
    reset();
  });

  afterEach(() => {
    config.alerts.maintenanceWindows = originalWindows;
    config.alerts.maintenanceDeadlineMs = originalDeadline;
    reset();
  });

  async function appWith(client: never, retryMs = 20) {
    const express = (await import('express')).default;
    const { createAlertHandler } = await import('./alert.js');
    const app = express();
    app.use(express.json());
    app.post('/v1/alert', createAlertHandler(client, undefined, retryMs));
    return app;
  }
  const post = (app: Awaited<ReturnType<typeof appWith>>, body: unknown) =>
    request(app).post('/v1/alert').set('authorization', `Bearer ${TOKEN}`).send(body as object);

  it('holds and releases without touching Discord', async () => {
    const client = { users: { fetch: vi.fn().mockRejectedValue(new Error('discord down')) } } as never;
    const app = await appWith(client);
    expect((await post(app, inWindow(0, 'vault')).expect(200)).body.action).toBe('held');
    expect((await post(app, inWindow(1, 'vault')).expect(200)).body.action).toBe('released');
    expect(heldCount()).toBe(0);
  });

  it('keeps the hold and retries when the DM fails at the deadline', async () => {
    config.alerts.maintenanceDeadlineMs = 10;
    const d = fakeDiscord();
    let fail = true;
    const client = {
      users: {
        fetch: vi.fn(async () => {
          if (fail) throw new Error('discord down');
          return (await (d.client as { users: { fetch: () => Promise<unknown> } }).users.fetch()) as never;
        }),
      },
    } as never;
    const app = await appWith(client);
    await post(app, inWindow(0, 'vault')).expect(200);
    await new Promise((r) => setTimeout(r, 60));
    expect(heldCount()).toBe(1);
    expect(d.send).not.toHaveBeenCalled();

    fail = false;
    await new Promise((r) => setTimeout(r, 80));
    expect(heldCount()).toBe(0);
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it('waits for the client to log in before sending a restored hold', async () => {
    const { addHold } = await import('../alertStore.js');
    addHold({ monitor: 'plane', since: Date.now() - 600_000, deadlineAt: Date.now() - 1000, window: 'w', detail: 'timeout' });
    const d = fakeDiscord();
    let ready = false;
    const client = Object.assign(d.client as object, { isReady: () => ready }) as never;
    await appWith(client);
    await new Promise((r) => setTimeout(r, 60));
    expect(d.send).not.toHaveBeenCalled();
    expect(heldCount()).toBe(1);

    ready = true;
    await new Promise((r) => setTimeout(r, 60));
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(heldCount()).toBe(0);
  });

  /** A client whose first user fetch waits on a gate, so a test can act while the send is in flight. */
  function gatedClient(d: ReturnType<typeof fakeDiscord>) {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const client = {
      users: {
        fetch: vi.fn(async () => {
          await gate;
          return (await (d.client as { users: { fetch: () => Promise<unknown> } }).users.fetch()) as never;
        }),
      },
    } as never;
    return { client, release };
  }

  it('makes an UP that lands during the deadline send wait, then edits the DOWN message', async () => {
    config.alerts.maintenanceDeadlineMs = 10;
    const d = fakeDiscord();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    d.send.mockImplementationOnce((async () => {
      await gate;
      return { id: 'msg-1' };
    }) as never);
    const app = await appWith(d.client);
    await post(app, inWindow(0, 'vault')).expect(200);
    await new Promise((r) => setTimeout(r, 40)); // the deadline fires; dm.send is waiting
    const up = post(app, inWindow(1, 'vault')).then((r) => r);
    await new Promise((r) => setTimeout(r, 20));
    release();
    expect((await up).body.action).toBe('edited');
    expect(d.send).toHaveBeenCalledTimes(1); // the DOWN message
    expect(d.edit).toHaveBeenCalledTimes(1); // edited to recovered
    expect(JSON.stringify(d.edit.mock.calls[0])).toContain('recovered');
    expect(heldCount()).toBe(0);
    expect(activeBatches()).toHaveLength(0);
  });

  it('answers a repeated DOWN with held while the deadline DM is in flight', async () => {
    config.alerts.maintenanceDeadlineMs = 10;
    const d = fakeDiscord();
    const { client, release } = gatedClient(d);
    const app = await appWith(client);
    await post(app, inWindow(0, 'vault')).expect(200);
    await new Promise((r) => setTimeout(r, 40));
    const again = await post(app, inWindow(0, 'vault')).expect(200);
    expect(again.body.action).toBe('held');
    release();
    await new Promise((r) => setTimeout(r, 60));
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it('sends one recovered message for an over-deadline outage that recovers while Discord is down', async () => {
    config.alerts.maintenanceDeadlineMs = 10;
    const d = fakeDiscord();
    let down = true;
    const client = {
      users: {
        fetch: vi.fn(async () => {
          if (down) throw new Error('discord down');
          return (await (d.client as { users: { fetch: () => Promise<unknown> } }).users.fetch()) as never;
        }),
      },
    } as never;
    const app = await appWith(client, 30);
    await post(app, inWindow(0, 'vault')).expect(200);
    await new Promise((r) => setTimeout(r, 50));
    const up = await post(app, inWindow(1, 'vault')).expect(200);
    expect(up.body.action).toBe('recovered_late');
    expect(heldCount()).toBe(1);

    down = false;
    await new Promise((r) => setTimeout(r, 100));
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(d.send.mock.calls[0])).toContain('recovered after');
    expect(d.edit).not.toHaveBeenCalled();
    expect(heldCount()).toBe(0);
    expect(activeBatches()).toHaveLength(0);
  });

  it('undoes the batch entry and restores the hold when the deadline send fails', async () => {
    config.alerts.maintenanceDeadlineMs = 10;
    const d = fakeDiscord();
    d.send.mockRejectedValueOnce(new Error('discord 500'));
    const app = await appWith(d.client, 150);
    await post(app, inWindow(0, 'vault')).expect(200);
    await new Promise((r) => setTimeout(r, 50)); // first attempt fails
    expect(activeBatches()).toHaveLength(0);

    // The next in-window DOWN is held again, not swallowed by a batch with no message.
    const again = await post(app, inWindow(0, 'vault')).expect(200);
    expect(again.body.action).toBe('held');
    await new Promise((r) => setTimeout(r, 250)); // the retry succeeds
    expect(d.send).toHaveBeenCalledTimes(2); // the failed attempt, then the retry
    expect(heldCount()).toBe(0);
  });

  it('does not train the baseline from a recovery after the deadline', async () => {
    const { addHold } = await import('../alertStore.js');
    const { stats } = await import('../baseline.js');
    addHold({ monitor: 'plane', since: Date.now() - 600_000, deadlineAt: Date.now() - 1000, window: 'w', detail: 'x' });
    const client = { isReady: () => false } as never; // keeps the hold from expiring first
    const app = await appWith(client, 60_000);
    await post(app, inWindow(1, 'plane')).expect(200);
    expect(stats('plane')).toBeNull();
  });

  it('answers a repeated DOWN with held while dm.send itself is in flight', async () => {
    config.alerts.maintenanceDeadlineMs = 10;
    const d = fakeDiscord();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    d.send.mockImplementationOnce((async () => {
      await gate;
      return { id: 'msg-1' };
    }) as never);
    const app = await appWith(d.client);
    await post(app, inWindow(0, 'vault')).expect(200);
    await new Promise((r) => setTimeout(r, 40)); // the deadline fires; dm.send is waiting
    const again = await post(app, inWindow(0, 'vault')).expect(200);
    expect(again.body.action).toBe('held');
    release();
    await new Promise((r) => setTimeout(r, 40));
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it('does not close an incident whose monitor went down again after a late UP', async () => {
    config.alerts.maintenanceDeadlineMs = 10;
    const d = fakeDiscord();
    let down = true;
    const client = {
      users: {
        fetch: vi.fn(async () => {
          if (down) throw new Error('discord down');
          return (await (d.client as { users: { fetch: () => Promise<unknown> } }).users.fetch()) as never;
        }),
      },
    } as never;
    const app = await appWith(client, 30);
    await post(app, inWindow(0, 'vault')).expect(200);
    await new Promise((r) => setTimeout(r, 50));
    await post(app, inWindow(1, 'vault')).expect(200); // late UP
    const again = await post(app, inWindow(0, 'vault')).expect(200); // down again
    expect(again.body.action).toBe('held');

    down = false;
    await new Promise((r) => setTimeout(r, 100));
    expect(d.send).toHaveBeenCalledTimes(1); // the DOWN message
    expect(d.edit).not.toHaveBeenCalled(); // never edited to recovered
    expect(heldCount()).toBe(0);
  });

  it('retries the recovered message when its send fails, and never sends a DOWN', async () => {
    config.alerts.maintenanceDeadlineMs = 10;
    const d = fakeDiscord();
    let down = true;
    const client = {
      users: {
        fetch: vi.fn(async () => {
          if (down) throw new Error('discord down');
          return (await (d.client as { users: { fetch: () => Promise<unknown> } }).users.fetch()) as never;
        }),
      },
    } as never;
    d.send.mockRejectedValueOnce(new Error('send failed'));
    const app = await appWith(client, 30);
    await post(app, inWindow(0, 'vault')).expect(200);
    await new Promise((r) => setTimeout(r, 50));
    await post(app, inWindow(1, 'vault')).expect(200);
    down = false;
    await new Promise((r) => setTimeout(r, 200));

    expect(d.send).toHaveBeenCalledTimes(2); // the failed attempt, then the retry
    expect(JSON.stringify(d.send.mock.calls[1])).toContain('recovered after');
    expect(heldCount()).toBe(0);
  });

  it('announces a second outage that starts while the first deadline DM is in flight as the same message', async () => {
    config.alerts.maintenanceDeadlineMs = 10;
    const d = fakeDiscord();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    d.send.mockImplementationOnce((async () => {
      await gate;
      return { id: 'msg-1' };
    }) as never);
    const app = await appWith(d.client);
    await post(app, inWindow(0, 'vault')).expect(200);
    await new Promise((r) => setTimeout(r, 40));
    expect(heldCount()).toBe(1);
    expect((await post(app, inWindow(0, 'vault')).expect(200)).body.action).toBe('held');
    release();
    await new Promise((r) => setTimeout(r, 40));
    expect(heldCount()).toBe(0);
    expect(d.send).toHaveBeenCalledTimes(1);
    // The red message stands, and a later DOWN edits it rather than posting again.
    expect((await post(app, inWindow(0, 'vault')).expect(200)).body.action).toBe('edited');
  });

  it('reports how long the monitor has been down, not zero', async () => {
    const { addHold } = await import('../alertStore.js');
    addHold({ monitor: 'plane', since: Date.now() - 600_000, deadlineAt: Date.now() - 1000, window: 'w', detail: 'timeout' });
    const d = fakeDiscord();
    await appWith(d.client);
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.stringify(d.send.mock.calls[0])).toContain('down for 10m');
  });
});
