/** pete-bot's GitHub App client (PET-645): the JWT, the token cache, and the pinned merge. */
import { describe, it, expect } from 'bun:test';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { appJwt, GitHubApp } from './github.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

describe('appJwt', () => {
  it('signs RS256 with the App id as issuer and a backdated iat', () => {
    const jwt = appJwt('42', PEM, 1_000_000);
    const [h, p, sig] = jwt.split('.');
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: '42' });
  });
});

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const tokenResponse = () =>
  Response.json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });

describe('GitHubApp', () => {
  it('mints one installation token and reuses it', async () => {
    const { f, calls } = fakeFetch((url) => (url.endsWith('/access_tokens') ? tokenResponse() : Response.json({ default_branch: 'main' })));
    const gh = new GitHubApp({ appId: '1', installationId: '2', privateKeyPem: PEM, org: 'PeteDio-Labs', fetchImpl: f });
    await gh.defaultBranch('a');
    await gh.defaultBranch('b');
    expect(calls.filter((c) => c.url.endsWith('/access_tokens'))).toHaveLength(1);
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe('Bearer ghs_test');
  });

  it('pins the squash merge to the SHA it was given', async () => {
    const { f, calls } = fakeFetch((url) => (url.endsWith('/access_tokens') ? tokenResponse() : Response.json({ sha: 'm'.repeat(40), merged: true })));
    const gh = new GitHubApp({ appId: '1', installationId: '2', privateKeyPem: PEM, org: 'PeteDio-Labs', fetchImpl: f });
    const r = await gh.merge('petedio-vault', 9, 'a'.repeat(40), 'Docs');
    expect(r).toEqual({ ok: true, sha: 'm'.repeat(40) });
    const merge = calls.at(-1)!;
    expect(merge.url).toBe('https://api.github.com/repos/PeteDio-Labs/petedio-vault/pulls/9/merge');
    expect(JSON.parse(merge.init.body as string)).toEqual({ sha: 'a'.repeat(40), merge_method: 'squash', commit_title: 'Docs (#9)' });
  });

  it('returns a refused merge as a value, with the status', async () => {
    const { f } = fakeFetch((url) => (url.endsWith('/access_tokens') ? tokenResponse() : new Response('Head branch was modified', { status: 409 })));
    const gh = new GitHubApp({ appId: '1', installationId: '2', privateKeyPem: PEM, org: 'PeteDio-Labs', fetchImpl: f });
    expect(await gh.merge('r', 1, 'a'.repeat(40), 't')).toEqual({ ok: false, status: 409, message: 'Head branch was modified' });
  });

  it('counts check runs and statuses, and treats skipped as passed', async () => {
    const { f } = fakeFetch((url) => {
      if (url.endsWith('/access_tokens')) return tokenResponse();
      if (url.includes('/check-runs')) {
        return Response.json({
          total_count: 3,
          check_runs: [
            { name: 'ci', status: 'completed', conclusion: 'success' },
            { name: 'skip', status: 'completed', conclusion: 'skipped' },
            { name: 'slow', status: 'in_progress', conclusion: null },
          ],
        });
      }
      return Response.json({ statuses: [{ context: 'legacy', state: 'failure' }] });
    });
    const gh = new GitHubApp({ appId: '1', installationId: '2', privateKeyPem: PEM, org: 'o', fetchImpl: f });
    expect(await gh.checks('r', 'a'.repeat(40))).toEqual({ total: 4, passed: 2, pending: ['slow'], failed: ['legacy (failure)'] });
  });

  it('refuses a partial thread read', async () => {
    const { f } = fakeFetch((url) =>
      url.endsWith('/access_tokens')
        ? tokenResponse()
        : Response.json({ data: { repository: { pullRequest: { reviewThreads: { totalCount: 101, nodes: [] } } } } }),
    );
    const gh = new GitHubApp({ appId: '1', installationId: '2', privateKeyPem: PEM, org: 'o', fetchImpl: f });
    await expect(gh.unresolvedThreads('r', 1)).rejects.toThrow('more than one page');
  });
});
