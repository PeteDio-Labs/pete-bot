/**
 * The lab tool library (PET-668). Proxmox and Kuma run against recorded fixtures through a
 * stub fetch; the git-backed tools run against real throwaway repos.
 *
 * The failure cases matter most: each one is a read that must not come back as an empty
 * success (an unauthorized Proxmox token, an unreachable Kuma, an empty vault).
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { GitClone, runGit } from './git.js';
import { gitHistoryTool } from './history.js';
import { findHostTool, HostIndex, hostNoteTool, parseFrontmatter, parseInventory } from './hosts.js';
import { buildLabTools, toolDefinitions } from './index.js';
import { kumaStatusTool } from './kuma.js';
import { ProxmoxClient, pveGuestsTool, pveGuestTool } from './proxmox.js';
import { makeTestRepo, type TestRepo } from './testGit.js';
import { callTool, capText, inputJsonSchema, LabToolError, type LabTool, type ToolResult } from './types.js';

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8');
const CA = '-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----\n';

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
function stubFetch(routes: Record<string, Route>, seen: Array<{ url: string; init?: RequestInit }> = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init });
    for (const [suffix, route] of Object.entries(routes)) if (url.endsWith(suffix)) return route(url, init);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}
const json = (body: string, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'application/json' } });

function data(r: ToolResult): { source: string; data: Record<string, unknown> } {
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return JSON.parse(r.text);
}
function error(r: ToolResult): string {
  if (r.ok) throw new Error(`expected an error, got: ${r.text}`);
  return r.error;
}

describe('callTool', () => {
  const echo: LabTool = {
    name: 'echo',
    description: 'test',
    input: z.object({ n: z.number().int().max(3) }),
    async run({ n }) {
      if (n === 2) throw new LabToolError('source said no');
      if (n === 3) throw new Error('secret internals at /etc/x');
      return { source: 'echo', data: { n, pad: 'x'.repeat(5000) } };
    },
  };

  it('refuses invalid input without running the tool', async () => {
    expect(error(await callTool(echo, { n: 9 }))).toContain('invalid input: n:');
    expect(error(await callTool(echo, { n: 1, extra: true }))).toBe('echo: invalid input: input: Unrecognized key(s) in object: \'extra\'');
  });

  it('passes a LabToolError message through and hides any other error', async () => {
    expect(error(await callTool(echo, { n: 2 }))).toBe('echo: source said no');
    const hidden = error(await callTool(echo, { n: 3 }));
    expect(hidden).toBe('echo: internal error (Error)');
    expect(hidden).not.toContain('/etc/x');
  });

  it('caps the output and says what it dropped', async () => {
    const r = await callTool(echo, { n: 1 }, 1000);
    if (!r.ok) throw new Error(r.error);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(1000);
    expect(r.text).toMatch(/truncated: \d+ of \d+ bytes dropped$/);
  });
});

describe('capText', () => {
  it('never splits a multi-byte character', () => {
    const { text } = capText('é'.repeat(200), 120);
    expect(text).not.toContain('�');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(120);
  });
});

describe('inputJsonSchema', () => {
  it('converts the shapes the tools use', () => {
    const schema = inputJsonSchema(
      z.object({
        a: z.string().min(1).max(5).describe('A'),
        b: z.number().int().min(1).max(50).default(15),
        c: z.enum(['x', 'y']).optional(),
      }),
    );
    expect(schema).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string', minLength: 1, maxLength: 5, description: 'A' },
        b: { type: 'integer', minimum: 1, maximum: 50, default: 15 },
        c: { type: 'string', enum: ['x', 'y'] },
      },
      required: ['a'],
      additionalProperties: false,
    });
  });

  it('throws on a shape it does not know, so a wrong schema cannot ship', () => {
    expect(() => inputJsonSchema(z.object({ a: z.array(z.string()) }))).toThrow('unsupported');
  });
});

describe('pve_guests and pve_guest', () => {
  const cfg = { baseUrl: 'https://192.168.50.10:8006', tokenId: 'lab-agent@pve!audit', tokenSecret: 's3cret', caPem: CA };
  const ok = {
    '/cluster/resources?type=vm': json(fixture('pve-cluster-resources.json')),
    '/nodes/pve03/lxc/235/config': json(fixture('pve-lxc-235-config.json')),
  };

  it('lists guests without templates, sorted, and sends a GET with the token and the CA', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const tool = pveGuestsTool(new ProxmoxClient({ ...cfg, fetch: stubFetch(ok, seen) }));
    const out = data(await callTool(tool, {}));
    const guests = out.data.guests as Array<{ vmid: number; memMiB: number; tags: string[] }>;
    expect(guests.map((g) => g.vmid)).toEqual([110, 235, 236]);
    expect(guests[1]).toMatchObject({ vmid: 235, node: 'pve03', status: 'running', memMiB: 4096, maxMemMiB: 8192, tags: ['core', 'plane'] });
    expect(out.source).toBe('3 guests from Proxmox cluster/resources');
    expect(seen[0]!.url).toBe('https://192.168.50.10:8006/api2/json/cluster/resources?type=vm');
    expect(seen[0]!.init?.method).toBe('GET');
    expect((seen[0]!.init?.headers as Record<string, string>).Authorization).toBe('PVEAPIToken=lab-agent@pve!audit=s3cret');
    expect((seen[0]!.init as { tls?: { ca?: string } }).tls?.ca).toBe(CA);
  });

  it('filters by node and status and says how many it read before filtering', async () => {
    const tool = pveGuestsTool(new ProxmoxClient({ ...cfg, fetch: stubFetch(ok) }));
    const out = data(await callTool(tool, { node: 'pve02', status: 'running' }));
    expect((out.data.guests as unknown[]).length).toBe(1);
    expect(out.source).toBe('3 guests from Proxmox cluster/resources, 1 after node pve02, status running');
  });

  it('reports an unauthorized token as an error', async () => {
    const tool = pveGuestsTool(new ProxmoxClient({ ...cfg, fetch: stubFetch({ '/cluster/resources?type=vm': json('{"data":null}', 401) }) }));
    expect(error(await callTool(tool, {}))).toBe('pve_guests: Proxmox refused the token lab-agent@pve!audit (HTTP 401)');
  });

  it('reports a token that sees no guests as an error, not an empty lab', async () => {
    const tool = pveGuestsTool(new ProxmoxClient({ ...cfg, fetch: stubFetch({ '/cluster/resources?type=vm': json('{"data":[]}') }) }));
    expect(error(await callTool(tool, {}))).toContain('returned 0 guests');
  });

  it('reports an unreachable node as an error and leaks no secret', async () => {
    const down = (() => Promise.reject(new TypeError('connect ECONNREFUSED'))) as unknown as typeof fetch;
    const tool = pveGuestsTool(new ProxmoxClient({ ...cfg, fetch: down }));
    const e = error(await callTool(tool, {}));
    expect(e).toContain('unreachable (connect ECONNREFUSED)');
    expect(e).not.toContain('s3cret');
  });

  it('reports a node that does not answer in time as an error', async () => {
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const tool = pveGuestsTool(new ProxmoxClient({ ...cfg, timeoutMs: 20, fetch: hang }));
    expect(error(await callTool(tool, {}))).toContain('no answer within 20 ms');
  });

  it('summarizes one guest and drops secret-bearing keys', async () => {
    const tool = pveGuestTool(new ProxmoxClient({ ...cfg, fetch: stubFetch(ok) }));
    const out = data(await callTool(tool, { vmid: 235 }));
    const config = out.data.config as Record<string, unknown>;
    expect(config).toMatchObject({ hostname: 'plane-235', cores: 4, features: 'keyctl=1,nesting=1' });
    expect(config).not.toHaveProperty('password');
    expect(config).not.toHaveProperty('ssh-public-keys');
    expect(config).not.toHaveProperty('digest');
    expect(config).not.toHaveProperty('description');
    expect(out.source).toContain('/nodes/pve03/lxc/235/config');
  });

  it('says how many guests it searched when a VMID is missing', async () => {
    const tool = pveGuestTool(new ProxmoxClient({ ...cfg, fetch: stubFetch(ok) }));
    expect(error(await callTool(tool, { vmid: 999 }))).toBe('pve_guest: no guest 999 among 3 guests in cluster/resources');
  });

  it('refuses to start without a CA or over plain http, so TLS is never unverified', () => {
    expect(() => new ProxmoxClient({ ...cfg, caPem: '' })).toThrow('CA PEM');
    expect(() => new ProxmoxClient({ ...cfg, baseUrl: 'http://192.168.50.10:8006' })).toThrow('https://');
  });
});

describe('kuma_status', () => {
  const cfg = { baseUrl: 'http://192.168.50.4:3001', slug: 'fault-study' };
  const ok = {
    '/api/status-page/fault-study': json(fixture('kuma-status-page.json')),
    '/api/status-page/heartbeat/fault-study': json(fixture('kuma-heartbeat.json')),
  };

  it('reads each monitor, when its state began, and its uptime', async () => {
    const out = data(await callTool(kumaStatusTool({ ...cfg, fetch: stubFetch(ok) }), {}));
    const monitors = out.data.monitors as Array<Record<string, unknown>>;
    expect(out.source).toBe('3 monitors from Uptime Kuma status page "fault-study", 2 not up');
    expect(monitors[0]).toMatchObject({ name: 'vault-223', group: 'Core', status: 'down', since: '2026-10-19 07:00:20', message: '503 - sealed', uptime24h: 95.12 });
    expect(monitors[1]).toMatchObject({ name: 'plane-235', status: 'up', uptime24h: 100 });
    expect(monitors[2]).toMatchObject({ name: 'plex-gpu', status: 'no beats', lastBeat: null });
  });

  it('returns only monitors that are not up, when asked', async () => {
    const out = data(await callTool(kumaStatusTool({ ...cfg, fetch: stubFetch(ok) }), { only: 'not_up' }));
    expect((out.data.monitors as Array<{ name: string }>).map((m) => m.name)).toEqual(['vault-223', 'plex-gpu']);
  });

  it('reports an unreachable Kuma as an error', async () => {
    const down = (() => Promise.reject(new TypeError('connect EHOSTUNREACH'))) as unknown as typeof fetch;
    expect(error(await callTool(kumaStatusTool({ ...cfg, fetch: down }), {}))).toContain('unreachable (connect EHOSTUNREACH)');
  });

  it('reports a status page with no monitors as an error, not as all up', async () => {
    const empty = stubFetch({ ...ok, '/api/status-page/fault-study': json('{"publicGroupList":[]}') });
    expect(error(await callTool(kumaStatusTool({ ...cfg, fetch: empty }), {}))).toContain('lists 0 monitors');
  });

  it('reports a heartbeat answer with no heartbeatList as an error, not as "no beats"', async () => {
    const odd = stubFetch({ ...ok, '/api/status-page/heartbeat/fault-study': json('{}') });
    expect(error(await callTool(kumaStatusTool({ ...cfg, fetch: odd }), {}))).toContain('has no heartbeatList');
  });

  it('reports a missing status page as an error', async () => {
    const gone = stubFetch({ '/api/status-page/heartbeat/fault-study': json('{}'), '/api/status-page/fault-study': json('{}', 404) });
    expect(error(await callTool(kumaStatusTool({ ...cfg, fetch: gone }), {}))).toContain('HTTP 404');
  });
});

const PLANE_NOTE = `---
type: host
kind: lxc
vmid: 235
host: plane-235
address: 192.168.50.235
node: pve03
status: live
verified: 2026-09-06 # checked against pct
---
# 235 · plane-235

Plane CE.
`;
const QBIT_NOTE = PLANE_NOTE.replace(/235/g, '110').replace('plane-110', 'qbittorrent-vpn').replace('pve03', 'pve02');
const INVENTORY = `---
type: index
---
# Hosts

| VMID | Name | State | Block |
|---|---|---|---|
| 999 | not-live | running | History table, must be skipped |

## Live inventory — ground-truthed 2026-09-10

### pve02 · \`192.168.50.11\`

| VMID | Name | State | Block |
|---|---|---|---|
| 110 | [[110-qbittorrent-vpn\\|qbittorrent-vpn]] | running | Media — beside the disks |

### pve03 · \`192.168.50.10\`

| VMID | Name | State | Block |
|---|---|---|---|
| 235 | [[235-plane\\|plane-235]] | running | Core — the tracker |

## Gone

| 242 | resume | destroyed | gone |
`;

describe('vault notes', () => {
  it('parses frontmatter and drops trailing comments', () => {
    expect(parseFrontmatter(PLANE_NOTE).frontmatter).toMatchObject({ vmid: '235', node: 'pve03', verified: '2026-09-06' });
  });

  it('reads only the live inventory rows, with their node', () => {
    expect(parseInventory(INVENTORY)).toEqual([
      { vmid: 110, name: 'qbittorrent-vpn', state: 'running', node: 'pve02', block: 'Media' },
      { vmid: 235, name: 'plane-235', state: 'running', node: 'pve03', block: 'Core' },
    ]);
  });

  describe('against a clone', () => {
    let repo: TestRepo;
    let index: HostIndex;
    beforeAll(async () => {
      repo = await makeTestRepo();
      await repo.commit(
        {
          'Hosts/235-plane.md': PLANE_NOTE,
          'Hosts/110-qbittorrent-vpn.md': QBIT_NOTE,
          'Hosts/hosts-inventory.md': INVENTORY,
          'Systems/plane.md': '---\ntype: system\n---\n',
        },
        'Add host notes',
      );
      index = new HostIndex(new GitClone('petedio-vault', repo.clone, 'main', 0));
    });

    it('finds a host by VMID, with its inventory row and the commit it read', async () => {
      const out = data(await callTool(findHostTool(index), { query: '235' }));
      expect(out.data.notes).toEqual([expect.objectContaining({ file: 'Hosts/235-plane.md', vmid: '235', node: 'pve03' })]);
      expect(out.data.inventory).toEqual([expect.objectContaining({ vmid: 235, node: 'pve03' })]);
      expect(out.source).toMatch(/^2 host notes and 2 inventory rows from petedio-vault at [0-9a-f]{7} \(/);
    });

    it('finds a host by name and says when nothing matches', async () => {
      expect((data(await callTool(findHostTool(index), { query: 'qbittorrent' })).data.notes as unknown[]).length).toBe(1);
      expect(data(await callTool(findHostTool(index), { query: 'nothing-here' })).data.note).toContain('no host note');
    });

    it('reads one note, and refuses an ambiguous query', async () => {
      const out = data(await callTool(hostNoteTool(index), { query: 'plane' }));
      expect(out.data.body).toContain('Plane CE.');
      expect(error(await callTool(hostNoteTool(index), { query: '192.168.50' }))).toContain('matches 2 notes');
    });

    it('serves the last good commit when a fetch fails, and marks it stale', async () => {
      const broken = new GitClone('petedio-vault', repo.clone, 'main', 0, async (dir, args) => {
        if (args[0] === 'fetch') throw new Error('git fetch exited 128: could not read from remote');
        return runGit(dir, args);
      });
      const out = data(await callTool(findHostTool(new HostIndex(broken)), { query: '235' }));
      expect(out.source).toContain('STALE: last fetch failed (git fetch exited 128: could not read from remote)');
    });

    it('reads a note whose name is not ASCII', async () => {
      await repo.commit({ 'Hosts/239-café.md': PLANE_NOTE.replace(/235/g, '239').replace('plane-239', 'cafe-239') }, 'Add café');
      expect((data(await callTool(findHostTool(index), { query: '239' })).data.notes as unknown[]).length).toBe(1);
    });

    it('picks up a new commit on origin', async () => {
      await repo.commit({ 'Hosts/238-usaa.md': PLANE_NOTE.replace(/235/g, '238').replace('plane-238', 'usaa-238') }, 'Add usaa');
      const out = data(await callTool(findHostTool(index), { query: 'usaa' }));
      expect(out.source).toMatch(/^4 host notes/);
    });
  });

  it('reports a vault with no host notes as an error', async () => {
    const repo = await makeTestRepo();
    await repo.commit({ 'Hosts/hosts-inventory.md': INVENTORY }, 'Inventory only');
    const tool = findHostTool(new HostIndex(new GitClone('petedio-vault', repo.clone, 'main', 0)));
    expect(error(await callTool(tool, { query: '235' }))).toContain('read 0 host notes');
  });

  it('reports a clone that does not exist as an error', async () => {
    const tool = findHostTool(new HostIndex(new GitClone('petedio-vault', '/nonexistent/clone', 'main', 0)));
    expect(error(await callTool(tool, { query: '235' }))).toContain('petedio-vault clone has no readable main');
  });
});

describe('git_history', () => {
  let tool: LabTool;
  beforeAll(async () => {
    const repo = await makeTestRepo();
    await repo.commit({ 'environments/homelab/plane.tf': 'a' }, 'PET-600: add plane (#10)');
    await repo.commit({ 'ansible/x.yml': 'b' }, 'PET-617: wire the gateway, refs PET-617 and PET-645');
    await repo.commit({ 'environments/homelab/plane.tf': 'c' }, 'PET-660: give plane a claude user');
    tool = gitHistoryTool([new GitClone('petedio-iac', repo.clone, 'main', 0)]);
  });

  it('lists commits newest first with their PET keys', async () => {
    const out = data(await callTool(tool, { repo: 'petedio-iac', limit: 2 }));
    const commits = out.data.commits as Array<{ subject: string; pet: string[]; sha: string }>;
    expect(commits.map((c) => c.subject)).toEqual(['PET-660: give plane a claude user', 'PET-617: wire the gateway, refs PET-617 and PET-645']);
    expect(commits[1]!.pet).toEqual(['PET-617', 'PET-645']);
    expect(commits[0]!.sha).toMatch(/^[0-9a-f]{7}$/);
    expect(out.source).toMatch(/^2 commits from petedio-iac at [0-9a-f]{7}/);
  });

  it('filters by path and by text', async () => {
    const byPath = data(await callTool(tool, { repo: 'petedio-iac', path: 'environments/homelab/plane.tf' }));
    expect((byPath.data.commits as unknown[]).length).toBe(2);
    expect(byPath.source).toContain('matching path environments/homelab/plane.tf');
    const byText = data(await callTool(tool, { repo: 'petedio-iac', text: 'gateway' }));
    expect((byText.data.commits as Array<{ pet: string[] }>)[0]!.pet).toContain('PET-617');
  });

  it('refuses a path that could be read as an option or leave the repo', async () => {
    for (const path of ['--output=/tmp/x', '../etc', 'a/../../b', 'a b', 'a;rm']) {
      expect(error(await callTool(tool, { repo: 'petedio-iac', path }))).toContain('must be a plain repo-relative path');
    }
  });

  it('treats text as a fixed string, not an option', async () => {
    const out = data(await callTool(tool, { repo: 'petedio-iac', text: '--all' }));
    expect(out.data.commits).toEqual([]);
  });

  it('refuses a repo it does not hold', async () => {
    expect(error(await callTool(tool, { repo: 'petedio-vault' }))).toContain('invalid input: repo');
  });
});

describe('buildLabTools', () => {
  it('builds every tool, and each one has a valid input schema', () => {
    const clone = new GitClone('petedio-iac', '/nonexistent');
    const tools = buildLabTools({
      vault: new GitClone('petedio-vault', '/nonexistent'),
      history: [clone],
      proxmox: { baseUrl: 'https://x:8006', tokenId: 'a@pve!b', tokenSecret: 'c', caPem: CA },
      kuma: { baseUrl: 'http://x:3001', slug: 'fault-study' },
      secrets: { addr: 'https://x:8200', token: 't', caPem: CA },
      deskHealthUrl: 'http://127.0.0.1:3015/health',
      units: ['pete-bot.service', 'lab-agent.service'],
    });
    const defs = toolDefinitions(tools);
    expect(defs.map((d) => d.name)).toEqual([
      'find_host', 'host_note', 'pve_guests', 'pve_guest', 'kuma_status', 'git_history', 'desk_status', 'systemd_status', 'vault_presence',
    ]);
    for (const d of defs) {
      expect(d.input_schema.type).toBe('object');
      expect(d.description.length).toBeGreaterThan(40);
    }
  });
});
