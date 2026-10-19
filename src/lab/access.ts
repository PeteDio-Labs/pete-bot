/**
 * Cloudflare Access checks for the lab MCP (PET-667).
 *
 * Every request to pdlab.dev/mcp/lab passes Access first: Managed OAuth admits Pedro's
 * email only. Access then adds `Cf-Access-Jwt-Assertion`, an RS256 JWT signed with the
 * team's keys. This module verifies that JWT at the origin: its signature against the team's
 * JWKS, its `aud` against the lab app's AUD tag, its issuer, its expiry, and its email.
 *
 * ⚠ TWO CHECKS, BECAUSE EITHER ALONE HAS FAILED OPEN. The origin also accepts only the
 * tunnel's address (LXC 112), and nftables on 237 drops every other source (PET-670). The
 * Plane shim relies on the firewall alone; a firewall rule that a deploy forgets leaves that
 * port open to the LAN. The JWT check holds even then.
 */
import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';

export interface AccessConfig {
  /** Such as petedio.cloudflareaccess.com */
  teamDomain: string;
  /** The Access application's AUD tag. */
  aud: string;
  /** Emails allowed through, lower-case. */
  emails: string[];
  fetch?: typeof fetch;
  now?: () => number;
}

export type AccessResult = { ok: true; email: string } | { ok: false; reason: string };

interface Jwk extends JsonWebKey {
  kid?: string;
}

const JWKS_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_SEC = 60;

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export class AccessVerifier {
  private keys = new Map<string, Jwk>();
  private fetchedAt = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly cfg: AccessConfig) {
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(cfg.teamDomain)) throw new Error('Access team domain must look like <team>.cloudflareaccess.com');
    if (!/^[0-9a-f]{64}$/.test(cfg.aud)) throw new Error('Access AUD tag must be 64 hex characters');
    if (cfg.emails.length === 0) throw new Error('Access needs at least one allowed email');
    this.fetchImpl = cfg.fetch ?? fetch;
    this.now = cfg.now ?? Date.now;
  }

  get issuer(): string {
    return `https://${this.cfg.teamDomain}`;
  }

  private async key(kid: string): Promise<Jwk | undefined> {
    const stale = this.now() - this.fetchedAt > JWKS_TTL_MS;
    if (stale || !this.keys.has(kid)) {
      // Refetch on an unknown kid too, so a key rotation needs no restart. At most once a
      // minute, so a stream of forged kids can't turn into a stream of fetches.
      if (stale || this.now() - this.fetchedAt > 60_000) {
        try {
          await this.refresh();
        } catch (err) {
          // A failed refetch keeps the keys already held, so one bad answer from Cloudflare
          // can't lock everyone out. With no key for this kid, the failure is the answer.
          if (!this.keys.has(kid)) throw err;
        }
      }
    }
    return this.keys.get(kid);
  }

  private async refresh(): Promise<void> {
    this.fetchedAt = this.now();
    const res = await this.fetchImpl(`${this.issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`Access certs answered HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = new Map((body?.keys ?? []).filter((k) => k.kid && k.kty === 'RSA').map((k) => [k.kid!, k]));
    // An answer with no keys keeps the old ones, so one bad fetch can't lock everyone out.
    if (keys.size === 0) throw new Error('Access certs answered with no RSA keys');
    this.keys = keys;
  }

  async verify(token: string | null): Promise<AccessResult> {
    if (!token) return { ok: false, reason: 'no Cf-Access-Jwt-Assertion header' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed JWT' };
    const [h, p, s] = parts as [string, string, string];
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = b64urlJson(h);
      payload = b64urlJson(p);
    } catch {
      return { ok: false, reason: 'malformed JWT' };
    }
    // JSON.parse accepts `null`, a number or an array; only an object is a JWT part.
    const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!isObject(header) || !isObject(payload)) return { ok: false, reason: 'malformed JWT' };
    // Pin the algorithm: never let the token choose it.
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, reason: 'JWT is not RS256 with a kid' };

    let jwk: Jwk | undefined;
    try {
      jwk = await this.key(header.kid);
    } catch (err) {
      return { ok: false, reason: `cannot read Access certs: ${(err as Error).message}` };
    }
    if (!jwk) return { ok: false, reason: 'JWT signed by an unknown key' };
    const good = verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
    if (!good) return { ok: false, reason: 'bad JWT signature' };

    const nowSec = Math.floor(this.now() / 1000);
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(this.cfg.aud)) return { ok: false, reason: 'JWT is for another Access application' };
    if (payload.iss !== this.issuer) return { ok: false, reason: 'JWT has the wrong issuer' };
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SEC < nowSec) return { ok: false, reason: 'JWT expired' };
    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SEC > nowSec) return { ok: false, reason: 'JWT not yet valid' };
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    if (!email || !this.cfg.emails.includes(email)) return { ok: false, reason: 'email not allowed' };
    return { ok: true, email };
  }
}
