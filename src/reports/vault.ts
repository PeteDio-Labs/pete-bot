/**
 * The audit's doc-freshness check (PET-701): `verified:` dates in a read-only vault clone.
 * It reads files and runs nothing.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export type VaultRead =
  | { ok: true; notes: number; dated: number; stale: { note: string; verified: string }[]; thresholdDays: number }
  | { ok: false; error: string };

const SKIP = new Set(['.git', '.obsidian', 'Archive', 'node_modules', 'threads']);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (name.endsWith('.md')) out.push(path);
  }
}

export function readVault(root: string, now: Date, thresholdDays = 30): VaultRead {
  try {
    const files: string[] = [];
    walk(root, files);
    if (files.length === 0) return { ok: false, error: `no notes under ${root}` };
    let dated = 0;
    const stale: { note: string; verified: string }[] = [];
    const cutoff = now.getTime() - thresholdDays * 86_400_000;
    for (const f of files) {
      const head = readFileSync(f, 'utf8').slice(0, 1200);
      const fm = /^---\n([\s\S]*?)\n---/.exec(head);
      const m = fm ? /^verified:\s*(\d{4}-\d{2}-\d{2})/m.exec(fm[1]!) : null;
      if (!m) continue;
      dated++;
      if (Date.parse(m[1]!) < cutoff) stale.push({ note: relative(root, f), verified: m[1]! });
    }
    stale.sort((a, b) => a.verified.localeCompare(b.verified));
    return { ok: true, notes: files.length, dated, stale, thresholdDays };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
