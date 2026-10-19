/**
 * Read access to one private repository through a GitHub App (PET-670).
 *
 * ⚠ NOT A DEPLOY KEY. PeteDio-Labs disables deploy keys for every repository it owns, so a
 * key GitHub would refuse is the failure this replaces. lab-agent holds the read-only
 * petedio-workspace-mirror App's key, as petedio-search does (PET-542).
 *
 * ⚠ EACH TOKEN READS ONE REPOSITORY. The installation reaches more than the vault, so every
 * mint asks for `repositories: [repo]` and `contents: read` and nothing else. GitHub refuses
 * a request for more than the installation holds, so this can only narrow.
 *
 * The token reaches git through GIT_CONFIG_* environment variables, never an argument: the
 * process's argv is readable by every user on the host, and its environment is not.
 */
import { appJwt } from '../../desk/github.js';

const API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 20_000;

export interface RepoTokenOptions {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  /** The repository name inside the installation's account, such as `petedio-vault`. */
  repo: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Extra environment for one git command. */
export type GitAuth = () => Promise<Record<string, string>>;

export function repoReadToken(opts: RepoTokenOptions): () => Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  let cached: { value: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt - now() > 5 * 60_000) return cached.value;
    const jwt = appJwt(opts.appId, opts.privateKeyPem, Math.floor(now() / 1000));
    const res = await fetchImpl(`${API}/app/installations/${opts.installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'lab-agent',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ repositories: [opts.repo], permissions: { contents: 'read' } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // GitHub's message names the refusal; it never echoes the JWT.
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`minting a read token for ${opts.repo} failed: GitHub answered HTTP ${res.status} ${detail}`.trim());
    }
    const body = (await res.json()) as { token: string; expires_at: string };
    cached = { value: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
  };
}

/** git's own way to carry a header, set through the environment so no argument holds it. */
export function gitAuthFromToken(token: () => Promise<string>): GitAuth {
  return async () => {
    const basic = Buffer.from(`x-access-token:${await token()}`).toString('base64');
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    };
  };
}
