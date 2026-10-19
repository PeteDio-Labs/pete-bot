/**
 * find_host and host_note: what the knowledge vault says about a machine (PET-668).
 *
 * The vault keys every host note on VMID (`Hosts/<vmid>-<name>.md`), and
 * `Hosts/hosts-inventory.md` holds the ground-truthed guest table under "## Live inventory".
 * Both are read from a read-only clone of petedio-vault at its fetched `main`.
 *
 * ⚠ THE VAULT IS A DOCUMENT, NOT THE MACHINE. Live infra outranks it (the vault's own first
 * rule), so every answer carries the note's `verified:` date and the commit it was read at.
 * To see what is running, a caller asks pve_guests.
 */
import { z } from 'zod';
import { GitClone } from './git.js';
import { LabToolError, type LabTool } from './types.js';

const HOSTS_DIR = 'Hosts';
const INVENTORY = `${HOSTS_DIR}/hosts-inventory.md`;
const MAX_NOTE_BYTES = 12 * 1024;

export interface HostNote {
  file: string;
  frontmatter: Record<string, string>;
  body: string;
}

export interface InventoryRow {
  vmid: number;
  name: string;
  state: string;
  node: string;
  block: string;
}

/** Parse flat `key: value` frontmatter. The vault's host frontmatter has no nesting. */
export function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  const frontmatter: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (!kv?.[1]) continue;
    // Drop a trailing comment, then matching quotes.
    const value = (kv[2] ?? '').replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
    frontmatter[kv[1]] = value;
  }
  return { frontmatter, body: text.slice(match[0].length) };
}

/**
 * Rows of the live inventory: every `| <vmid> | ... |` row under a `### pveNN` heading inside
 * "## Live inventory". Rows elsewhere in the note (history, the node summary) are skipped.
 */
export function parseInventory(text: string): InventoryRow[] {
  const rows: InventoryRow[] = [];
  let inLive = false;
  let node = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      inLive = /^## Live inventory/i.test(line);
      node = '';
      continue;
    }
    if (!inLive) continue;
    const heading = /^### (\S+)/.exec(line);
    if (heading?.[1]) {
      node = heading[1];
      continue;
    }
    if (!node) continue;
    // Split on pipes that are not escaped inside a wikilink alias (`[[a\|b]]`).
    const cells = line.split(/(?<!\\)\|/).map((c) => c.trim());
    if (cells.length < 5 || !/^\d+$/.test(cells[1] ?? '')) continue;
    const nameCell = cells[2] ?? '';
    const alias = /\[\[[^\]]*?\\\|([^\]]+)\]\]/.exec(nameCell) ?? /\[\[([^\]|]+)\]\]/.exec(nameCell);
    rows.push({
      vmid: Number(cells[1]),
      name: (alias?.[1] ?? nameCell).trim(),
      state: cells[3] ?? '',
      node,
      block: (cells[4] ?? '').split(/\s+[—-]\s+/)[0]?.trim() ?? '',
    });
  }
  return rows;
}

interface VaultIndex {
  sha: string;
  source: string;
  notes: HostNote[];
  inventory: InventoryRow[];
}

/** Reads and caches the vault's host notes, once per commit. */
export class HostIndex {
  private cached: VaultIndex | null = null;

  constructor(private readonly clone: GitClone) {}

  async load(): Promise<VaultIndex> {
    await this.clone.refresh();
    const state = await this.clone.state();
    if (this.cached?.sha === state.sha) {
      // Same commit, but the fetch state may have changed: rebuild only the source line.
      return { ...this.cached, source: GitClone.describe(this.clone.name, state) };
    }

    let files: string[];
    try {
      files = (await this.clone.listFiles(HOSTS_DIR)).filter((f) => f.endsWith('.md'));
    } catch (err) {
      throw new LabToolError(`cannot list ${HOSTS_DIR}/ in ${this.clone.name}: ${(err as Error).message}`);
    }
    const notes: HostNote[] = [];
    let inventory: InventoryRow[] = [];
    for (const name of files) {
      const file = `${HOSTS_DIR}/${name}`;
      const text = await this.clone.readFile(file);
      if (file === INVENTORY) {
        inventory = parseInventory(text);
        continue;
      }
      const { frontmatter, body } = parseFrontmatter(text);
      if (frontmatter.type !== 'host') continue;
      notes.push({ file, frontmatter, body });
    }
    // An empty read is a failure, never "no such host" (see types.ts).
    if (notes.length === 0) throw new LabToolError(`read 0 host notes from ${this.clone.name}/${HOSTS_DIR}`);
    if (inventory.length === 0) throw new LabToolError(`read 0 rows from the live inventory in ${INVENTORY}`);

    this.cached = { sha: state.sha, source: GitClone.describe(this.clone.name, state), notes, inventory };
    return this.cached;
  }
}

function matches(note: HostNote, query: string): boolean {
  const q = query.toLowerCase();
  const fm = note.frontmatter;
  if (/^\d+$/.test(q)) return fm.vmid === q;
  const base = note.file.slice(HOSTS_DIR.length + 1, -3).toLowerCase();
  return [fm.host, fm.address, base].some((v) => v?.toLowerCase().includes(q));
}

const QUERY = z
  .string()
  .min(1)
  .max(64)
  .describe('A VMID such as "235", or part of a host name, note name or address such as "plane" or ".235"');

export function findHostTool(index: HostIndex): LabTool {
  const input = z.object({ query: QUERY });
  return {
    name: 'find_host',
    description:
      "Look up a machine in the knowledge vault: its host note's frontmatter (VMID, node, address, status, " +
      'verified date) and its row in the live inventory table. The vault is a document; ask pve_guests for live state.',
    input,
    async run({ query }: z.infer<typeof input>) {
      const idx = await index.load();
      const hits = idx.notes.filter((n) => matches(n, query));
      const vmids = new Set(hits.map((n) => n.frontmatter.vmid));
      const rows = idx.inventory.filter(
        (r) => vmids.has(String(r.vmid)) || r.name.toLowerCase().includes(query.toLowerCase()) || String(r.vmid) === query,
      );
      return {
        source: `${idx.notes.length} host notes and ${idx.inventory.length} inventory rows from ${idx.source}`,
        data: {
          notes: hits.map((n) => ({ file: n.file, ...n.frontmatter })),
          inventory: rows,
          ...(hits.length === 0 && rows.length === 0 ? { note: `no host note or inventory row matches "${query}"` } : {}),
        },
      };
    },
  };
}

export function hostNoteTool(index: HostIndex): LabTool {
  const input = z.object({ query: QUERY });
  return {
    name: 'host_note',
    description:
      "Read one host note's full text from the knowledge vault, by VMID or name. Fails when the query " +
      'matches more than one note; narrow it with find_host first.',
    input,
    async run({ query }: z.infer<typeof input>) {
      const idx = await index.load();
      const hits = idx.notes.filter((n) => matches(n, query));
      if (hits.length === 0) throw new LabToolError(`no host note matches "${query}" (searched ${idx.notes.length})`);
      if (hits.length > 1) {
        throw new LabToolError(`"${query}" matches ${hits.length} notes: ${hits.map((n) => n.file).join(', ')}`);
      }
      const note = hits[0]!;
      const bytes = Buffer.byteLength(note.body, 'utf8');
      const body =
        bytes > MAX_NOTE_BYTES
          ? `${Buffer.from(note.body, 'utf8').subarray(0, MAX_NOTE_BYTES).toString('utf8')}\n… note cut at ${MAX_NOTE_BYTES} of ${bytes} bytes`
          : note.body;
      return {
        source: `${note.file} from ${idx.source}`,
        data: { file: note.file, frontmatter: note.frontmatter, body },
      };
    },
  };
}
