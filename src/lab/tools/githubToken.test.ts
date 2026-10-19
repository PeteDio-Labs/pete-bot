import { describe, expect, it } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { GitClone, type GitRunner } from './git.js';
import { gitAuthFromToken, repoReadToken } from './githubToken.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const NOW = Date.parse('2026-10-19T09:00:00Z');

function fakeGitHub(status = 201) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(
      JSON.stringify(status === 201 ? { token: `ghs_${calls.length}`, expires_at: new Date(NOW + 3_600_000).toISOString() } : { message: 'Bad credentials' }),
      { status },
    );
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('repoReadToken (PET-670)', () => {
  it('asks for contents:read on the one repository, and caches the token', async () => {
    const gh = fakeGitHub();
    let now = NOW;
    const token = repoReadToken({ appId: '1', installationId: '42', privateKeyPem: PEM, repo: 'petedio-vault', fetchImpl: gh.fetchImpl, now: () => now });
    expect(await token()).toBe('ghs_1');
    now += 30 * 60_000;
    expect(await token()).toBe('ghs_1');
    expect(gh.calls).toEqual([
      { url: 'https://api.github.com/app/installations/42/access_tokens', body: { repositories: ['petedio-vault'], permissions: { contents: 'read' } } },
    ]);
    now += 26 * 60_000; // within five minutes of expiry
    expect(await token()).toBe('ghs_2');
  });

  it('turns a refusal into a stale vault fetch that names it', async () => {
    const gh = fakeGitHub(401);
    const token = repoReadToken({ appId: '1', installationId: '42', privateKeyPem: PEM, repo: 'petedio-vault', fetchImpl: gh.fetchImpl, now: () => NOW });
    const runs: string[][] = [];
    const git: GitRunner = async (_dir, args) => {
      runs.push(args);
      return args[0] === 'log' ? 'abc1234\x1f2026-10-19T08:00:00Z\n' : '';
    };
    const clone = new GitClone('petedio-vault', '/x', 'main', 0, git, () => NOW).useAuth(gitAuthFromToken(token));
    await clone.refresh();
    const s = await clone.state();
    expect(s.fetchError).toContain('HTTP 401');
    expect(runs.some((a) => a[0] === 'fetch')).toBe(false);
  });

  it('hands git the token through the environment, never an argument', async () => {
    const gh = fakeGitHub();
    const token = repoReadToken({ appId: '1', installationId: '42', privateKeyPem: PEM, repo: 'petedio-vault', fetchImpl: gh.fetchImpl, now: () => NOW });
    const seen: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const git: GitRunner = async (_dir, args, env) => {
      seen.push({ args, env });
      return '';
    };
    await new GitClone('petedio-vault', '/x', 'main', 0, git, () => NOW).useAuth(gitAuthFromToken(token)).refresh();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.args.join(' ')).not.toContain('ghs_');
    expect(seen[0]!.env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_1').toString('base64')}`,
    });
  });
});
