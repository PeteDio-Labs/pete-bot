/**
 * vault_presence: which secrets exist in Vault, and which version each is at (PET-667).
 *
 * It reads KV v2 METADATA only, with a token whose policy grants `list` and `read` on
 * `kv/metadata/services/*` and nothing on `kv/data/`. So it can show that
 * `services/lab-agent` exists at version 3, written at 07:12Z, and it cannot read a value.
 * Field names live in the data, so it cannot list those either.
 *
 * ⚠ VAULT SEALS EVERY NIGHT AT ABOUT 02:45 until the Pi's watcher unseals it. A sealed Vault
 * answers 503, and this tool says "Vault is sealed", never "0 secrets".
 */
import { z } from 'zod';
import { fetchWithTimeout, LabToolError, type LabTool } from './types.js';

export interface VaultConfig {
  /** Such as https://192.168.50.223:8200 */
  addr: string;
  token: string;
  caPem: string;
  /** The KV v2 mount, `kv`. */
  mount?: string;
  /** The folder under the mount this tool may list, `services`. */
  prefix?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface Metadata {
  current_version?: number;
  oldest_version?: number;
  created_time?: string;
  updated_time?: string;
  versions?: Record<string, { created_time?: string; deletion_time?: string; destroyed?: boolean }>;
}

export class VaultMetadataClient {
  private readonly mount: string;
  private readonly prefix: string;

  constructor(private readonly cfg: VaultConfig) {
    if (!/^https:\/\//.test(cfg.addr)) throw new Error('Vault address must be https://');
    if (!cfg.caPem.includes('BEGIN CERTIFICATE')) throw new Error('Vault CA PEM is missing or malformed');
    this.mount = cfg.mount ?? 'kv';
    this.prefix = cfg.prefix ?? 'services';
  }

  private async call(method: 'GET' | 'LIST', path: string): Promise<unknown> {
    const res = await fetchWithTimeout(
      this.cfg.fetch ?? fetch,
      `${this.cfg.addr.replace(/\/$/, '')}/v1/${this.mount}/metadata/${path}`,
      { method, headers: { 'X-Vault-Token': this.cfg.token }, tls: { ca: this.cfg.caPem } },
      this.cfg.timeoutMs ?? 8_000,
      `Vault ${method} ${this.mount}/metadata/${path}`,
    );
    if (res.status === 503) throw new LabToolError('Vault is sealed (HTTP 503); it seals nightly at about 02:45 until the watcher unseals it');
    if (res.status === 403) throw new LabToolError(`Vault refused the lab-agent token for ${this.mount}/metadata/${path} (HTTP 403)`);
    if (res.status === 404) return null;
    if (!res.ok) throw new LabToolError(`Vault ${method} ${this.mount}/metadata/${path} answered HTTP ${res.status}`);
    try {
      return ((await res.json()) as { data?: unknown }).data ?? null;
    } catch {
      throw new LabToolError(`Vault ${method} ${this.mount}/metadata/${path} answered with a body that is not JSON`);
    }
  }

  async list(): Promise<string[]> {
    const data = (await this.call('LIST', `${this.prefix}/`)) as { keys?: string[] } | null;
    const keys = data?.keys ?? [];
    // Every lab service has a path here; an empty list means the policy or the path is wrong.
    if (keys.length === 0) throw new LabToolError(`Vault listed 0 secrets under ${this.mount}/metadata/${this.prefix}/`);
    return keys;
  }

  async metadata(name: string): Promise<Metadata | null> {
    return (await this.call('GET', `${this.prefix}/${name}`)) as Metadata | null;
  }

  /**
   * Renew the token. The seed script mints a periodic token, which expires unless renewed
   * within its period; main.ts calls this twice a day. `renew-self` is in Vault's default
   * policy, so the token needs no extra grant for it.
   */
  async renewSelf(): Promise<void> {
    const res = await fetchWithTimeout(
      this.cfg.fetch ?? fetch,
      `${this.cfg.addr.replace(/\/$/, '')}/v1/auth/token/renew-self`,
      { method: 'POST', headers: { 'X-Vault-Token': this.cfg.token }, body: '{}', tls: { ca: this.cfg.caPem } },
      this.cfg.timeoutMs ?? 8_000,
      'Vault renew-self',
    );
    if (!res.ok) throw new LabToolError(`Vault renew-self answered HTTP ${res.status}`);
  }

  get scope(): string {
    return `${this.mount}/metadata/${this.prefix}/`;
  }
}

export function vaultPresenceTool(client: VaultMetadataClient): LabTool {
  const input = z.object({
    name: z
      .string()
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'must be one secret name, such as "lab-agent"')
      .optional()
      .describe('One secret under services/, such as "pete-bot"; omit to list them all'),
  });
  return {
    name: 'vault_presence',
    description:
      'Which secrets exist under kv/services/ in Vault, with their current version and when each version was written. ' +
      'Metadata only: it never reads a value or a field name. Use it to confirm a seed script wrote a new version.',
    input,
    async run({ name }: z.infer<typeof input>) {
      if (!name) {
        const keys = await client.list();
        return { source: `${keys.length} entries listed under ${client.scope}`, data: { secrets: keys } };
      }
      const md = await client.metadata(name);
      if (!md) return { source: `${client.scope}${name}`, data: { name, exists: false } };
      const versions = Object.entries(md.versions ?? {})
        .map(([v, info]) => ({ version: Number(v), created: info.created_time ?? null, deleted: Boolean(info.deletion_time), destroyed: Boolean(info.destroyed) }))
        .sort((a, b) => b.version - a.version)
        .slice(0, 5);
      return {
        source: `${client.scope}${name}`,
        data: { name, exists: true, currentVersion: md.current_version ?? null, updated: md.updated_time ?? null, created: md.created_time ?? null, recentVersions: versions },
      };
    },
  };
}
