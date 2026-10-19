/**
 * The nightly drift check (PET-671): live Proxmox guests against the vault's inventory and
 * host notes. It runs inside lab-agent at LAB_DRIFT_AT (11:15Z by default).
 *
 * ⚠ CODE FINDS THE DRIFT, THE MODEL ONLY WORDS IT. compareLab() is a pure function over
 * three reads. Haiku turns its findings into a short DM through the gateway, and when the
 * gateway fails the DM carries the findings as plain lines instead. A model can't invent or
 * drop a finding, because it never decides what drifted.
 *
 * ⚠ EVERY DM SAYS WHAT THE RUN READ. "21 guests from Proxmox, 21 inventory rows, 27 host
 * notes" leads each message, so "no drift" and "read nothing" can never look alike. A run
 * with no drift logs those counts and sends nothing. A failed read sends a failure DM and
 * never reports "no drift" (PET-298, PET-374 and their kin).
 */
import type { CallModel } from './agent.js';
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

/** The findings as plain lines: the DM when the model is unavailable, and its input otherwise. */
export function plainLines(findings: DriftFinding[]): string {
  return findings.map((f) => `- ${f.vmid}: ${f.what}`).join('\n');
}

const DRIFT_PROMPT = `You write one Discord DM to Pedro about drift between his Proxmox cluster and his vault notes.

Rules:
- Use only the findings given. Never add, drop or guess a finding.
- Group findings by VMID. At most 10 short lines, for a phone screen. No preamble, no sign-off.
- Proxmox is the truth; say which note or table row needs an edit.`;

/** notify's message cap is 1,800 characters; the header line takes some of that. */
const MESSAGE_CAP = 1_700;

/**
 * The DM text for a run with findings. Haiku words it; when the gateway fails, the findings go
 * out as plain lines with the reason, so a model outage never hides drift.
 */
export async function draftDriftMessage(result: DriftResult, callModel: CallModel, model: string, signal?: AbortSignal): Promise<{ text: string; worded: boolean }> {
  const header = `Drift: ${result.findings.length} finding${result.findings.length === 1 ? '' : 's'}. Read ${result.read}.`;
  let body: string;
  let worded = false;
  try {
    const res = await callModel(
      {
        model,
        max_tokens: 400,
        system: DRIFT_PROMPT,
        messages: [{ role: 'user', content: plainLines(result.findings) }],
      },
      signal,
    );
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
    if (!text || res.stop_reason === 'refusal') throw new Error(`the model returned ${text ? 'a refusal' : 'no text'}`);
    body = text;
    worded = true;
  } catch (err) {
    body = `${plainLines(result.findings)}\n(Plain list: the model was unavailable: ${(err as Error).message.slice(0, 160)})`;
  }
  return { text: cap(`${header}\n${body}`), worded };
}

function cap(text: string): string {
  return text.length <= MESSAGE_CAP ? text : `${text.slice(0, MESSAGE_CAP - 40)}\n… cut; run /lab for the rest.`;
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

export type DriftOutcome =
  | { kind: 'clean'; read: string }
  | { kind: 'drift'; read: string; findings: number; worded: boolean }
  | { kind: 'read-failed'; error: string };

export interface DriftDeps {
  read: () => Promise<DriftReads>;
  callModel: CallModel;
  model: string;
  notify: Notify;
  log: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * One run. It never throws: every outcome is logged, and every outcome but a clean one is
 * DMed. A failed DM is logged as an error with the outcome it could not deliver.
 */
export async function runDriftCheck(deps: DriftDeps): Promise<DriftOutcome> {
  let outcome: DriftOutcome;
  let message: string | null = null;
  try {
    const result = compareLab(await deps.read());
    if (result.findings.length === 0) {
      outcome = { kind: 'clean', read: result.read };
    } else {
      const draft = await draftDriftMessage(result, deps.callModel, deps.model, AbortSignal.timeout(60_000));
      outcome = { kind: 'drift', read: result.read, findings: result.findings.length, worded: draft.worded };
      message = draft.text;
    }
  } catch (err) {
    const error = (err as Error).message;
    outcome = { kind: 'read-failed', error };
    message = cap(`Drift check FAILED: it could not read the lab, so it checked nothing tonight.\n${error}`);
  }

  deps.log('drift check', { ...outcome });
  if (message) {
    try {
      await deps.notify(message);
    } catch (err) {
      deps.log('drift check could not DM', { outcome: outcome.kind, error: (err as Error).message });
    }
  }
  return outcome;
}

/** Milliseconds from `now` to the next HH:MM UTC. */
export function msUntil(at: string, now: Date): number {
  const [h, m] = at.split(':').map(Number) as [number, number];
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}
