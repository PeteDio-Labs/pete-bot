/**
 * The nightly drift check (PET-671): live Proxmox guests against the vault's inventory and
 * host notes. It runs inside lab-agent at LAB_DRIFT_AT (11:15Z by default).
 *
 * ⚠ NO MODEL IS CALLED. compareLab() is a pure function over three reads, and the DM carries
 * its findings as plain lines. The check costs no API spend and can't invent or drop a
 * finding (PET-671, 2026-10-20: Pedro moved to a plan with no API credit).
 *
 * ⚠ EVERY DM SAYS WHAT THE RUN READ. "21 guests from Proxmox, 21 inventory rows, 27 host
 * notes" leads each message, so "no drift" and "read nothing" can never look alike. A run
 * with no drift logs those counts and sends nothing. A failed read sends a failure DM and
 * never reports "no drift" (PET-298, PET-374 and their kin).
 */
import type { Guest } from './tools/proxmox.js';
import type { HostNote, InventoryRow } from './tools/hosts.js';

/** One way the lab and the vault disagree. `vmid` keys the line, `what` says how. */
export interface DriftFinding {
  vmid: number;
  what: string;
}

export interface DriftReads {
  guests: Guest[];
  inventory: InventoryRow[];
  notes: HostNote[];
  /** Such as "petedio-vault @ 1a2b3c4 (fetched 06:12Z)". */
  vaultSource: string;
}

export interface DriftResult {
  /** What was read, as one line. Leads every DM. */
  read: string;
  findings: DriftFinding[];
}

const GUEST_KINDS = new Set(['lxc', 'vm']);
const LIVE_NODES = /^pve\d+$/;

/** Proxmox says running or stopped; the inventory writes the same words. */
const sameState = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function compareLab(reads: DriftReads): DriftResult {
  const live = new Map(reads.guests.map((g) => [g.vmid, g]));
  const rows = new Map(reads.inventory.map((r) => [r.vmid, r]));
  // Host notes for guests only: bare metal and nodes carry no VMID that Proxmox knows.
  const guestNotes = reads.notes.filter((n) => GUEST_KINDS.has(n.frontmatter.kind ?? '') && /^\d+$/.test(n.frontmatter.vmid ?? ''));
  const notes = new Map(guestNotes.map((n) => [Number(n.frontmatter.vmid), n]));
  const findings: DriftFinding[] = [];

  // A map keeps one entry per VMID, so a duplicate would vanish from every check below.
  const dupes = (vmids: number[], where: string) => {
    const seen = new Set<number>();
    for (const v of vmids) {
      if (seen.has(v)) findings.push({ vmid: v, what: `${where} lists VMID ${v} more than once` });
      seen.add(v);
    }
  };
  dupes(reads.inventory.map((r) => r.vmid), 'the inventory');
  dupes(guestNotes.map((n) => Number(n.frontmatter.vmid)), 'Hosts/');

  for (const g of reads.guests) {
    const row = rows.get(g.vmid);
    if (!row) {
      findings.push({ vmid: g.vmid, what: `${g.name} is on ${g.node} (${g.status}), but the inventory has no row for it` });
    } else {
      if (row.node !== g.node) findings.push({ vmid: g.vmid, what: `the inventory lists ${row.name} on ${row.node}; Proxmox has it on ${g.node}` });
      if (!sameState(row.state, g.status)) findings.push({ vmid: g.vmid, what: `the inventory says ${row.state || '(blank)'}; Proxmox says ${g.status}` });
      if (row.name !== g.name) findings.push({ vmid: g.vmid, what: `the inventory names it ${row.name}; Proxmox names it ${g.name}` });
    }
    const note = notes.get(g.vmid);
    if (!note) {
      findings.push({ vmid: g.vmid, what: `${g.name} has no host note in Hosts/` });
      continue;
    }
    const fm = note.frontmatter;
    if (fm.status === 'destroyed' || fm.node === 'none') {
      findings.push({ vmid: g.vmid, what: `${note.file} says status ${fm.status ?? '?'}, node ${fm.node ?? '?'}; Proxmox runs it on ${g.node}` });
    } else if (fm.node && fm.node !== g.node) {
      findings.push({ vmid: g.vmid, what: `${note.file} says node ${fm.node}; Proxmox has it on ${g.node}` });
    }
    if (fm.status === 'live' && g.status !== 'running') findings.push({ vmid: g.vmid, what: `${note.file} says status live; Proxmox says ${g.status}` });
    if (fm.status === 'down' && g.status === 'running') findings.push({ vmid: g.vmid, what: `${note.file} says status down; Proxmox says running` });
    if (fm.host && fm.host !== g.name) findings.push({ vmid: g.vmid, what: `${note.file} names the host ${fm.host}; Proxmox names it ${g.name}` });
  }

  for (const row of reads.inventory) {
    if (!live.has(row.vmid)) findings.push({ vmid: row.vmid, what: `the inventory lists ${row.name} on ${row.node}, but Proxmox has no guest ${row.vmid}` });
  }
  for (const [vmid, note] of notes) {
    if (live.has(vmid)) continue;
    const fm = note.frontmatter;
    // A destroyed or retired guest's note stays, keyed on its VMID, with node none.
    if (fm.status === 'live' || LIVE_NODES.test(fm.node ?? '')) {
      findings.push({ vmid, what: `${note.file} says status ${fm.status ?? '?'}, node ${fm.node ?? '?'}, but Proxmox has no guest ${vmid}` });
    }
  }

  findings.sort((a, b) => a.vmid - b.vmid || a.what.localeCompare(b.what));
  return {
    read: `${reads.guests.length} guests from Proxmox, ${reads.inventory.length} inventory rows, ${guestNotes.length} guest notes (${reads.vaultSource})`,
    findings,
  };
}

/** The findings as plain lines, one per VMID-keyed finding. */
export function plainLines(findings: DriftFinding[]): string {
  return findings.map((f) => `- ${f.vmid}: ${f.what}`).join('\n');
}

/** notify's message cap is 1,800 characters; the header line takes some of that. */
const MESSAGE_CAP = 1_700;

const FOOTER = 'Proxmox is the truth: edit the note or table row.';

/**
 * The DM text for a run with findings: the counts first, then one line per finding. Past the
 * cap it drops whole lines and says how many, and where the full list is. `journalctl -u
 * lab-agent` holds every finding, because the run's log line carries them (PET-671).
 */
export function driftMessage(result: DriftResult): string {
  const header = `Drift: ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'}. Read ${result.read}.`;
  const lines = plainLines(result.findings).split('\n');
  const whole = `${header}\n${lines.join('\n')}\n${FOOTER}`;
  if (whole.length <= MESSAGE_CAP) return whole;
  const more = (n: number) => `… ${n} more not shown. All ${lines.length} are in \`journalctl -u lab-agent\`, or POST /v1/drift/run.`;
  let kept = lines.length;
  const build = () => `${header}\n${lines.slice(0, kept).join('\n')}\n${more(lines.length - kept)}\n${FOOTER}`;
  while (kept > 0 && build().length > MESSAGE_CAP) kept--;
  return build();
}

function cap(text: string): string {
  return text.length <= MESSAGE_CAP ? text : `${text.slice(0, MESSAGE_CAP - 40)}\n… cut; run /lab for the rest.`;
}

/** A read that failed, with what each of the reads did. */
export class DriftReadError extends Error {
  override name = 'DriftReadError';
}

export interface LabReaders {
  guests: () => Promise<Guest[]>;
  vault: () => Promise<{ inventory: InventoryRow[]; notes: HostNote[]; source: string; fetchError: string | null }>;
}

/**
 * Both reads, each to its own end. Any failure throws a DriftReadError that names what every
 * read did, so the failure DM still says what the run read.
 *
 * ⚠ A STALE VAULT IS A FAILED READ. The clone never throws on a failed fetch: it answers from
 * the last commit it has. Comparing live Proxmox with a vault that stopped updating would
 * report "clean" every night after the deploy key broke, so a fetch error fails the run.
 */
export async function readLab(readers: LabReaders): Promise<DriftReads> {
  const [g, v] = await Promise.allSettled([readers.guests(), readers.vault()]);
  const parts: string[] = [];
  let failed = false;
  if (g.status === 'fulfilled') parts.push(`Proxmox: ${g.value.length} guests`);
  else {
    failed = true;
    parts.push(`Proxmox: FAILED, ${(g.reason as Error)?.message ?? String(g.reason)}`);
  }
  if (v.status === 'rejected') {
    failed = true;
    parts.push(`vault: FAILED, ${(v.reason as Error)?.message ?? String(v.reason)}`);
  } else if (v.value.fetchError) {
    failed = true;
    parts.push(`vault: STALE, the fetch failed (${v.value.fetchError}), so it holds ${v.value.source}`);
  } else {
    parts.push(`vault: ${v.value.inventory.length} inventory rows and ${v.value.notes.length} notes`);
  }
  if (failed || g.status !== 'fulfilled' || v.status !== 'fulfilled') throw new DriftReadError(parts.join('; '));
  return { guests: g.value, inventory: v.value.inventory, notes: v.value.notes, vaultSource: v.value.source };
}

export type Notify = (message: string) => Promise<void>;

/** POST one message to pete-bot's /v1/notify, as "lab-agent drift". Throws on anything but 2xx. */
export function notifier(url: string, token: string, fetchImpl: typeof fetch = fetch): Notify {
  return async (message) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'lab-agent drift check', message }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`/v1/notify answered HTTP ${res.status}`);
  };
}

type DriftKind =
  | { kind: 'clean'; read: string }
  | { kind: 'drift'; read: string; findings: number; lines: string[] }
  | { kind: 'read-failed'; error: string };
/** `delivered` is null when the run had nothing to send. */
export type DriftOutcome = DriftKind & { at: string; delivered: boolean | null };

export interface DriftDeps {
  read: () => Promise<DriftReads>;
  notify: Notify;
  /** Waits before each retry of a failed DM. Defaults to 15 s and 60 s: three tries in all. */
  retryDelaysMs?: number[];
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * One run. It never throws: every outcome is logged, and every outcome but a clean one is
 * DMed. A failed DM is logged as an error with the outcome it could not deliver.
 */
export async function runDriftCheck(deps: DriftDeps): Promise<DriftOutcome> {
  let outcome: DriftKind;
  let message: string | null = null;
  try {
    const result = compareLab(await deps.read());
    if (result.findings.length === 0) {
      outcome = { kind: 'clean', read: result.read };
    } else {
      outcome = { kind: 'drift', read: result.read, findings: result.findings.length, lines: plainLines(result.findings).split('\n') };
      message = driftMessage(result);
    }
  } catch (err) {
    const error = (err as Error).message;
    outcome = { kind: 'read-failed', error };
    message = cap(`Drift check FAILED: it could not read the lab, so it checked nothing tonight.\n${error}`);
  }

  // null when there was nothing to send, so a clean run never reads as a failed delivery.
  let delivered: boolean | null = null;
  if (message) {
    // One failed delivery must not lose the night: pete-bot may be restarting at 11:15Z.
    const delays = deps.retryDelaysMs ?? [15_000, 60_000];
    for (let attempt = 0; attempt <= delays.length && delivered !== true; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      try {
        await deps.notify(message);
        delivered = true;
      } catch (err) {
        delivered = false;
        deps.log('drift check could not DM', { level: 'error', outcome: outcome.kind, attempt: attempt + 1, error: (err as Error).message });
      }
    }
  }
  const done: DriftOutcome = { ...outcome, at: new Date().toISOString(), delivered };
  deps.log('drift check', { ...done });
  return done;
}

/**
 * One run at a time, shared by the schedule and POST /v1/drift/run: a second caller gets the
 * run already under way, so a manual run near LAB_DRIFT_AT sends one DM, not two.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    running ??= fn().finally(() => {
      running = null;
    });
    return running;
  };
}

/** Milliseconds from `now` to the next HH:MM UTC. */
export function msUntil(at: string, now: Date): number {
  const [h, m] = at.split(':').map(Number) as [number, number];
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}
