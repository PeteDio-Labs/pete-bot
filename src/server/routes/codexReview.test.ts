import { describe, expect, it } from 'bun:test';
import request from 'supertest';
import { createApp } from '../index.js';


const TOKEN = 'test-codex-review-token';
const app = () => createApp({} as never);

describe('/v1/codex-review', () => {
  it('refuses a missing, wrong, notify and alert bearer', async () => {
    await request(app()).post('/v1/codex-review').send({ repo: 'pete-bot', pr: 1 }).expect(401);
    for (const t of ['nope', 'test-notify-token', 'test-alert-token']) {
      await request(app()).post('/v1/codex-review').set('authorization', `Bearer ${t}`).send({ repo: 'pete-bot', pr: 1 }).expect(401);
      await request(app()).get('/v1/codex-review?repo=pete-bot&pr=1').set('authorization', `Bearer ${t}`).expect(401);
    }
  });

  it('says 503 while the desk is off, never an empty success', async () => {
    const res = await request(app()).post('/v1/codex-review').set('authorization', `Bearer ${TOKEN}`).send({ repo: 'pete-bot', pr: 1 }).expect(503);
    expect(res.body.error).toBe('desk_off');
  });

  it('rejects a repo name the gate would not take and a bad PR number', async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    await request(app()).post('/v1/codex-review').set(auth).send({ repo: 'Bad Repo;x', pr: 1 }).expect(400);
    await request(app()).post('/v1/codex-review').set(auth).send({ repo: 'pete-bot', pr: 0 }).expect(400);
    await request(app()).get('/v1/codex-review?repo=pete-bot&pr=abc').set(auth).expect(400);
  });
});
