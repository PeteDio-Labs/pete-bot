/**
 * The nightly drift check (PET-671): the comparison, the DM it drafts, and a run's outcomes.
 */
import { describe, expect, it } from 'bun:test';
import { compareLab, driftMessage, msUntil, readLab, runDriftCheck, singleFlight, type DriftReads } from './drift.js';
import { createLabHandler } from './server.js';
import type { ModelResponse } from './agent.js';
import type { Guest } from './tools/proxmox.js';
import type { HostNote, InventoryRow } from './tools/hosts.js';

const guest = (vmid: number, name: string, node = 'pve03', status = 'running'): Guest => ({
  vmid, name, node, status, type: 'lxc', uptimeSec: 1, cpus: 1, memMiB: 1, maxMemMiB: 1, tags: [],
});
const row = (vmid: number, name: string, node = 'pve03', state = 'running'): InventoryRow => ({ vmid, name, node, state, block: 'Apps' });
const note = (vmid: number, fm: Record<string, string> = {}): HostNote => ({
  file: `Hosts/${vmid}-x.md`,
  frontmatter: { type: 'host', kind: 'lxc', vmid: String(vmid), status: 'live', node: 'pve03', ...fm },
  body: '',
});

const clean: DriftReads = {
  guests: [guest(235, 'plane'), guest(237, 'media-dash')],
  inventory: [row(235, 'plane'), row(237, 'media-dash')],
  notes: [note(235), note(237), { file: 'Hosts/pve03.md', frontmatter: { type: 'host', kind: 'node', node: 'pve03' }, body: '' }],
  vaultSource: 'petedio-vault @ abc1234',
};

const reply = (text: string, stop = 'end_turn'): ModelResponse => ({ content: [{ type: 'text', text }], stop_reason: stop });

describe('compareLab', () => {
  it('finds nothing when the three reads agree, and says what it read', () => {
    const r = compareLab(clean);
    expect(r.findings).toEqual([]);
    expect(r.read).toBe('2 guests from Proxmox, 2 inventory rows, 2 guest notes (petedio-vault @ abc1234)');
  });

  it('reports each kind of drift, keyed by VMID', () => {
    const r = compareLab({
      ...clean,
      guests: [guest(235, 'plane', 'pve02', 'stopped'), guest(240, 'newbox'), guest(237, 'media-dash')],
      inventory: [row(235, 'plane-old'), row(237, 'media-dash'), row(299, 'ghost')],
      notes: [note(235), note(237, { status: 'destroyed', node: 'none' }), note(299), note(106, { status: 'destroyed', node: 'none' })],
    });
    const lines = r.findings.map((f) => `${f.vmid} ${f.what}`);
    expect(lines).toEqual([
      '235 Hosts/235-x.md says node pve03; Proxmox has it on pve02',
      '235 Hosts/235-x.md says status live; Proxmox says stopped',
      '235 the inventory lists plane-old on pve03; Proxmox has it on pve02',
      '235 the inventory names it plane-old; Proxmox names it plane',
      '235 the inventory says running; Proxmox says stopped',
      '237 Hosts/237-x.md says status destroyed, node none; Proxmox runs it on pve03',
      '240 newbox has no host note in Hosts/',
      '240 newbox is on pve03 (running), but the inventory has no row for it',
      '299 Hosts/299-x.md says status live, node pve03, but Proxmox has no guest 299',
      '299 the inventory lists ghost on pve03, but Proxmox has no guest 299',
    ]);
    // 106's note is destroyed with node none, and Proxmox has no 106: that is consistent.
    expect(lines.some((l) => l.startsWith('106'))).toBe(false);
  });

  it('reports a note whose status or host name disagrees, and a duplicated VMID', () => {
    const r = compareLab({
      ...clean,
      guests: [guest(235, 'plane', 'pve03', 'stopped'), guest(237, 'media-dash')],
      inventory: [row(235, 'plane', 'pve03', 'stopped'), row(237, 'media-dash'), row(237, 'media-dash')],
      notes: [note(235), note(237, { status: 'down', host: 'mediadash' })],
    });
    expect(r.findings.map((f) => `${f.vmid} ${f.what}`)).toEqual([
      '235 Hosts/235-x.md says status live; Proxmox says stopped',
      '237 Hosts/237-x.md names the host mediadash; Proxmox names it media-dash',
      '237 Hosts/237-x.md says status down; Proxmox says running',
      '237 the inventory lists VMID 237 more than once',
    ]);
  });
});

describe('readLab', () => {
  const vaultOk = async () => ({ inventory: clean.inventory, notes: clean.notes, source: 'petedio-vault @ abc1234', fetchError: null });

  it('returns the three reads when both succeed', async () => {
    const r = await readLab({ guests: async () => clean.guests, vault: vaultOk });
    expect(r.guests).toHaveLength(2);
    expect(r.vaultSource).toBe('petedio-vault @ abc1234');
  });

  it('fails on a stale vault, and names what each read did', async () => {
    const err = await readLab({
      guests: async () => clean.guests,
      vault: async () => ({ ...(await vaultOk()), source: 'petedio-vault @ abc1234 (STALE)', fetchError: 'Permission denied (publickey)' }),
    }).catch((e: Error) => e.message);
    expect(err).toBe('Proxmox: 2 guests; vault: STALE, the fetch failed (Permission denied (publickey)), so it holds petedio-vault @ abc1234 (STALE)');
  });

  it('keeps the vault count when Proxmox fails', async () => {
    const err = await readLab({
      guests: async () => {
        throw new Error('Proxmox refused the token lab-agent@pve!audit (HTTP 401)');
      },
      vault: vaultOk,
    }).catch((e: Error) => e.message);
    expect(err).toBe('Proxmox: FAILED, Proxmox refused the token lab-agent@pve!audit (HTTP 401); vault: 2 inventory rows and 3 notes');
  });
});

describe('singleFlight', () => {
  it('gives a second caller the run under way, then allows a new one', async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const once = singleFlight(async () => {
      runs++;
      await gate;
      return runs;
    });
    const a = once();
    const b = once();
    release();
    expect(await a).toBe(1);
    expect(await b).toBe(1);
    expect(await once()).toBe(2);
  });
});

describe('driftMessage', () => {
  const result = compareLab({ ...clean, guests: [...clean.guests, guest(240, 'newbox')] });

  it('leads with the counts, then one plain line per finding, and calls no model', () => {
    const text = driftMessage(result);
    expect(text.split('\n')[0]).toBe('Drift: 2 findings. Read 3 guests from Proxmox, 2 inventory rows, 2 guest notes (petedio-vault @ abc1234).');
    expect(text).toContain('- 240: newbox has no host note in Hosts/');
  });

  it('caps the message under notify\'s limit', () => {
    const many = { read: 'r', findings: Array.from({ length: 200 }, (_, i) => ({ vmid: i, what: 'x'.repeat(40) })) };
    const text = driftMessage(many);
    expect(text.length).toBeLessThanOrEqual(1700);
    expect(text).toMatch(/… \d+ more not shown\. All 200 are in `journalctl -u lab-agent`/);
    // Whole lines only, and the count adds up.
    const shown = text.split('\n').filter((l) => l.startsWith('- ')).length;
    expect(text).toContain(`… ${200 - shown} more not shown`);
    expect(text.endsWith('Proxmox is the truth: edit the note or table row.')).toBe(true);
  });
});

describe('runDriftCheck', () => {
  const deps = (read: () => Promise<DriftReads>, sent: string[], logs: Array<Record<string, unknown>>) => ({
    read,
    notify: async (m: string) => {
      sent.push(m);
    },
    log: (msg: string, f: Record<string, unknown> = {}) => logs.push({ msg, ...f }),
    retryDelaysMs: [0, 0],
  });

  it('logs the counts and sends nothing when clean', async () => {
    const sent: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const out = await runDriftCheck(deps(async () => clean, sent, logs));
    expect(out).toMatchObject({ kind: 'clean', delivered: null });
    expect(sent).toEqual([]);
    expect(logs[0]).toMatchObject({ msg: 'drift check', kind: 'clean', read: expect.stringContaining('2 guests') });
  });

  it('DMs a failed read and never reports no drift', async () => {
    const sent: string[] = [];
    const out = await runDriftCheck(deps(async () => {
      throw new Error('Proxmox refused the token lab-agent@pve!audit (HTTP 401)');
    }, sent, []));
    expect(out).toMatchObject({ kind: 'read-failed', error: 'Proxmox refused the token lab-agent@pve!audit (HTTP 401)', delivered: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Drift check FAILED');
    expect(sent[0]).toContain('HTTP 401');
  });

  it('logs a DM it could not deliver, and still returns the outcome', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const d = deps(async () => ({ ...clean, guests: [...clean.guests, guest(240, 'newbox')] }), [], logs);
    d.notify = async () => {
      throw new Error('/v1/notify answered HTTP 502');
    };
    const out = await runDriftCheck(d);
    expect(out).toMatchObject({ kind: 'drift', findings: 2, delivered: false });
    // Three tries, each logged, then the outcome.
    expect(logs.slice(0, 3).map((l) => l.attempt)).toEqual([1, 2, 3]);
    expect(logs[0]).toMatchObject({ msg: 'drift check could not DM', level: 'error', outcome: 'drift', error: '/v1/notify answered HTTP 502' });
    expect(logs[3]).toMatchObject({ msg: 'drift check', delivered: false });
  });

  it('delivers on a retry after pete-bot restarts, and sends one DM', async () => {
    const sent: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const d = deps(async () => ({ ...clean, guests: [...clean.guests, guest(240, 'newbox')] }), sent, logs);
    let calls = 0;
    d.notify = async (m: string) => {
      if (++calls < 3) throw new Error('ECONNREFUSED');
      sent.push(m);
    };
    const out = await runDriftCheck(d);
    expect(out).toMatchObject({ kind: 'drift', delivered: true });
    expect(sent).toHaveLength(1);
    expect(calls).toBe(3);
  });

  it('keeps every finding in the outcome and the log, past the DM cap', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const guests = Array.from({ length: 80 }, (_, i) => guest(300 + i, `extra-${i}`));
    const out = await runDriftCheck(deps(async () => ({ ...clean, guests: [...clean.guests, ...guests] }), [], logs));
    expect(out.kind).toBe('drift');
    if (out.kind === 'drift') {
      expect(out.lines).toHaveLength(out.findings);
      expect(out.findings).toBeGreaterThan(80);
    }
    expect(logs.at(-1)).toMatchObject({ msg: 'drift check', kind: 'drift', lines: expect.any(Array) });
  });
});

describe('msUntil', () => {
  it('finds the next 11:15Z, today or tomorrow', () => {
    expect(msUntil('11:15', new Date('2026-10-19T08:15:00Z'))).toBe(3 * 3600_000);
    expect(msUntil('11:15', new Date('2026-10-19T11:15:00Z'))).toBe(24 * 3600_000);
    expect(msUntil('11:15', new Date('2026-10-19T12:00:00Z'))).toBe(23.25 * 3600_000);
  });
});

describe('POST /v1/drift/run', () => {
  const ASK = 'a'.repeat(40);
  const handler = createLabHandler({
    askToken: ASK,
    tools: new Map(),
    callModel: async () => reply('x'),
    model: 'm',
    checks: {},
    runDrift: async () => ({ kind: 'clean', read: '2 guests', at: '2026-10-19T11:15:00Z', delivered: null }),
  });
  const post = (auth?: string) =>
    handler(new Request('http://x/v1/drift/run', { method: 'POST', headers: auth ? { authorization: auth } : {} }));

  it('needs the ask bearer, and answers with the outcome', async () => {
    expect((await post()).status).toBe(401);
    expect((await post('Bearer wrong')).status).toBe(401);
    const res = await post(`Bearer ${ASK}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: 'clean', read: '2 guests', at: '2026-10-19T11:15:00Z', delivered: null });
  });
});
