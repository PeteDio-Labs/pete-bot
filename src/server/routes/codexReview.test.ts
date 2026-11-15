import { describe, expect, it } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { codexReviewHandler } from './codexReview.js';
import { RefusedError } from '../../desk/review-requests.js';
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

describe('handler with a queue', () => {
  const calls: string[] = [];
  const fake = {
    request: async (repo: string, pr: number, effort?: string) => {
      calls.push(`${repo} ${pr} ${effort}`);
      if (repo === 'petedio-usaa') return { kind: 'refused', reason: 'not on the desk list' };
      return { kind: pr === 1 ? 'queued' : 'already-queued', request: { state: 'queued' } };
    },
    status: async (repo: string) => {
      if (repo === 'petedio-usaa') throw new RefusedError('not on the desk list');
      if (repo === 'boom') throw new Error('github down');
      return { head: 'abc', request: null, reviews: [] };
    },
  };
  const a = () => {
    const x = express();
    x.use(express.json());
    x.all('/c', codexReviewHandler(() => fake as never));
    return x;
  };
  const auth = { authorization: `Bearer ${TOKEN}` };

  it('answers 202 for a new request and 200 for a repeat, passing effort through', async () => {
    const r1 = await request(a()).post('/c').set(auth).send({ repo: 'pete-bot', pr: 1, effort: 'high' }).expect(202);
    expect(r1.body).toMatchObject({ ok: true, kind: 'queued' });
    await request(a()).post('/c').set(auth).send({ repo: 'pete-bot', pr: 2 }).expect(200);
    expect(calls[0]).toBe('pete-bot 1 high');
  });

  it('answers 403 for a refused repo on POST and GET', async () => {
    await request(a()).post('/c').set(auth).send({ repo: 'petedio-usaa', pr: 1 }).expect(403);
    await request(a()).get('/c?repo=petedio-usaa&pr=1').set(auth).expect(403);
  });

  it('reads status on GET and answers 502 when GitHub fails', async () => {
    const ok = await request(a()).get('/c?repo=pete-bot&pr=1').set(auth).expect(200);
    expect(ok.body).toMatchObject({ ok: true, head: 'abc', reviews: [] });
    await request(a()).get('/c?repo=boom&pr=1').set(auth).expect(502);
  });
});
