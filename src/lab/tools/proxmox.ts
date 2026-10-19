/**
 * pve_guests and pve_guest: live guest state from the Proxmox API (PET-668).
 *
 * The token is `lab-agent@pve!audit` with PVEAuditor on `/` and privilege separation
 * (PET-510's pattern), placed by PET-670's seed script. Every call is a GET.
 *
 * ⚠ AN EMPTY GUEST LIST IS AN ERROR. With privilege separation, a token missing its ACL gets
 * HTTP 200 and an empty `data` array from cluster/resources, which reads exactly like a lab
 * with no guests. The lab always has guests, so zero means the token sees nothing.
 *
 * ⚠ TLS IS VERIFIED AGAINST THE CLUSTER'S OWN CA. The nodes serve certificates signed by
 * `/etc/pve/pve-root-ca.pem`, which the deploy copies to the service. Verification is never
 * turned off.
 */
import { z } from 'zod';
import { fetchWithTimeout, LabToolError, type LabTool } from './types.js';

export interface ProxmoxConfig {
  /** Such as https://192.168.50.10:8006. Any node answers for the whole cluster. */
  baseUrl: string;
  /** Such as lab-agent@pve!audit */
  tokenId: string;
  tokenSecret: string;
  /** PEM of the cluster CA. */
  caPem: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface Guest {
  vmid: number;
  name: string;
  type: string;
  node: string;
  status: string;
  uptimeSec: number;
  cpus: number;
  memMiB: number;
  maxMemMiB: number;
  tags: string[];
}

/**
 * Config keys that can carry a credential or a key. Proxmox masks some; drop them all here.
 * `description` (the guest's Notes) is free text a person may have pasted anything into, so
 * SUMMARY_KEY leaves it out too.
 */
const SECRET_KEY = /pass|secret|token|sshkeys|^cipassword$|^cicustom$/i;
/** The config keys a "where and how does it run" answer needs. */
const SUMMARY_KEY = /^(hostname|name|cores|sockets|memory|swap|ostype|arch|onboot|startup|tags|features|unprivileged|protection|rootfs|scsi\d+|virtio\d+|sata\d+|mp\d+|net\d+|template|lock)$/;

const MiB = 1024 * 1024;

export class ProxmoxClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: ProxmoxConfig) {
    // A plain-http URL would ignore the CA and send the token secret in cleartext.
    if (!/^https:\/\//.test(cfg.baseUrl)) throw new Error('Proxmox base URL must be https://');
    if (!cfg.tokenId.includes('!')) throw new Error('Proxmox token id must look like user@realm!name');
    if (!cfg.caPem.includes('BEGIN CERTIFICATE')) throw new Error('Proxmox CA PEM is missing or malformed');
    this.fetchImpl = cfg.fetch ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetchWithTimeout(
      this.fetchImpl,
      `${this.cfg.baseUrl.replace(/\/$/, '')}/api2/json${path}`,
      {
        method: 'GET',
        headers: { Authorization: `PVEAPIToken=${this.cfg.tokenId}=${this.cfg.tokenSecret}` },
        tls: { ca: this.cfg.caPem },
      },
      this.timeoutMs,
      `Proxmox GET ${path}`,
    );
    if (res.status === 401) throw new LabToolError(`Proxmox refused the token ${this.cfg.tokenId} (HTTP 401)`);
    if (res.status === 403) throw new LabToolError(`Proxmox token ${this.cfg.tokenId} lacks permission for ${path} (HTTP 403)`);
    if (!res.ok) throw new LabToolError(`Proxmox GET ${path} answered HTTP ${res.status}`);
    let body: { data?: unknown };
    try {
      body = (await res.json()) as { data?: unknown };
    } catch {
      throw new LabToolError(`Proxmox GET ${path} answered with a body that is not JSON`);
    }
    if (body?.data === undefined || body.data === null) throw new LabToolError(`Proxmox GET ${path} answered with no data`);
    return body.data as T;
  }

  async guests(): Promise<Guest[]> {
    const raw = await this.get<Array<Record<string, unknown>>>('/cluster/resources?type=vm');
    if (!Array.isArray(raw)) throw new LabToolError('Proxmox cluster/resources did not answer with a list');
    if (raw.length === 0) {
      throw new LabToolError(
        `Proxmox cluster/resources returned 0 guests for ${this.cfg.tokenId}; the token likely lacks PVEAuditor on /`,
      );
    }
    return raw
      .filter((g) => !g.template)
      .map((g) => ({
        vmid: Number(g.vmid),
        name: String(g.name ?? ''),
        type: String(g.type ?? ''),
        node: String(g.node ?? ''),
        status: String(g.status ?? 'unknown'),
        uptimeSec: Number(g.uptime ?? 0),
        cpus: Number(g.maxcpu ?? 0),
        memMiB: Math.round(Number(g.mem ?? 0) / MiB),
        maxMemMiB: Math.round(Number(g.maxmem ?? 0) / MiB),
        tags: String(g.tags ?? '').split(/[;,\s]+/).filter(Boolean),
      }))
      .sort((a, b) => a.vmid - b.vmid);
  }
}

export function summarizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_KEY.test(key) || !SUMMARY_KEY.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function pveGuestsTool(client: ProxmoxClient): LabTool {
  const input = z.object({
    node: z.string().max(32).regex(/^[\w-]+$/).optional().describe('Only guests on this node, such as "pve03"'),
    status: z.enum(['running', 'stopped']).optional().describe('Only guests in this state'),
  });
  return {
    name: 'pve_guests',
    description:
      'Every Proxmox guest (LXC and VM) right now: VMID, name, node, status, uptime, CPU and memory. ' +
      'This is live state, which outranks the knowledge vault.',
    input,
    async run({ node, status }: z.infer<typeof input>) {
      const all = await client.guests();
      const guests = all.filter((g) => (!node || g.node === node) && (!status || g.status === status));
      const filter = [node && `node ${node}`, status && `status ${status}`].filter(Boolean).join(', ');
      return {
        source: `${all.length} guests from Proxmox cluster/resources${filter ? `, ${guests.length} after ${filter}` : ''}`,
        data: { guests },
      };
    },
  };
}

export function pveGuestTool(client: ProxmoxClient): LabTool {
  const input = z.object({ vmid: z.number().int().min(100).max(999_999_999).describe('The guest VMID, such as 235') });
  return {
    name: 'pve_guest',
    description:
      "One Proxmox guest in detail: its live status and a summary of its config (cores, memory, disks, " +
      'mounts, network, features). Secret-bearing config keys are never returned.',
    input,
    async run({ vmid }: z.infer<typeof input>) {
      const all = await client.guests();
      const guest = all.find((g) => g.vmid === vmid);
      if (!guest) throw new LabToolError(`no guest ${vmid} among ${all.length} guests in cluster/resources`);
      const kind = guest.type === 'qemu' ? 'qemu' : 'lxc';
      const config = await client.get<Record<string, unknown>>(`/nodes/${guest.node}/${kind}/${vmid}/config`);
      return {
        source: `guest ${vmid} from Proxmox cluster/resources and /nodes/${guest.node}/${kind}/${vmid}/config`,
        data: { ...guest, config: summarizeConfig(config) },
      };
    },
  };
}
