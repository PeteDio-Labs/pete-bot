/**
 * The tier of a PR, from petedio-iac's own classifier (PET-645).
 *
 * ⚠ ONE HOME FOR THE RULES. The tiers live in petedio-iac's scripts/pr-blast-radius.py
 * (PET-463), which the blast-radius workflow already runs for every repo. This module
 * runs that same file. It never restates a path rule, so the rules cannot drift.
 *
 * ⚠ THE RULES COME FROM THE DEFAULT BRANCH, NEVER FROM THE PR. The blast-radius workflow
 * grades petedio-iac with the PR's own copy, which is right for a label and wrong for a
 * gate: a PR could rewrite the rules and then pass them. The desk reads the classifier
 * and the base repository's workflows from default branches only. A PR that changes a
 * workflow is tier 2 by the rules themselves.
 *
 * ⚠ A RENAME COUNTS TWICE. Moving a file out of a tier-2 path is a tier-2 change, so a
 * renamed file's old path is classified beside its new one.
 *
 * Paths are passed with --paths-from, so a changed .tf file is never judged comment-only
 * here. That fails toward tier 2, which costs a tap and never a wrong merge.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileChange } from './github.js';

export interface Classification {
  tier: 0 | 1 | 2;
  /** One line per path at the PR's tier, for the report. */
  reasons: string[];
  pathCount: number;
}

export interface ClassifierSource {
  /** The classifier's text on the rules repository's default branch. */
  classifier(): Promise<string>;
  /** The base repository's workflow files on its default branch, by file name. */
  workflows(repo: string): Promise<Record<string, string>>;
}

export type RunPython = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

async function runPython(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), 60_000);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode: await proc.exited, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** Only these names are written to disk, so a workflow name cannot climb out of the directory. */
const SAFE_FILE = /^[A-Za-z0-9._-]+\.ya?ml$/;

export async function classify(
  repo: string,
  files: FileChange[],
  source: ClassifierSource,
  python: string,
  run: RunPython = runPython,
): Promise<Classification> {
  const paths = [...new Set(files.flatMap((f) => (f.previousPath ? [f.path, f.previousPath] : [f.path])))];
  if (paths.length === 0) throw new Error('the PR changes no files, so there is nothing to classify');

  const dir = await mkdtemp(join(tmpdir(), 'desk-classify-'));
  try {
    const wfDir = join(dir, 'root', '.github', 'workflows');
    await mkdir(wfDir, { recursive: true });
    for (const [name, text] of Object.entries(await source.workflows(repo))) {
      if (SAFE_FILE.test(name)) await writeFile(join(wfDir, name), text);
    }
    const script = join(dir, 'pr-blast-radius.py');
    await writeFile(script, await source.classifier());
    const list = join(dir, 'paths.txt');
    await writeFile(list, paths.join('\n') + '\n');

    // -I: isolated mode. Python adds neither the script's directory nor the environment's
    // PYTHON* settings to what it imports.
    const out = await run([python, '-I', script, '--paths-from', list, '--repo-root', join(dir, 'root'), '--json']);
    if (out.exitCode !== 0) {
      throw new Error(`the classifier exited ${out.exitCode}: ${out.stderr.trim().slice(-300)}`);
    }
    const parsed = JSON.parse(out.stdout) as {
      tier: number;
      floor_note: string | null;
      paths: { path: string; tier: number; reason: string }[];
    };
    if (parsed.tier !== 0 && parsed.tier !== 1 && parsed.tier !== 2) {
      throw new Error(`the classifier returned tier "${String(parsed.tier)}"`);
    }
    // Say what was examined, not only what was found: a tier over fewer paths than the PR
    // changed is no tier at all.
    if (!Array.isArray(parsed.paths) || parsed.paths.length !== paths.length) {
      throw new Error(`the classifier graded ${parsed.paths?.length ?? 0} of ${paths.length} paths`);
    }
    const top = parsed.paths.filter((p) => p.tier === parsed.tier).map((p) => `${p.path}: ${p.reason}`);
    if (parsed.floor_note) top.push(parsed.floor_note);
    return { tier: parsed.tier, reasons: top, pathCount: paths.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
