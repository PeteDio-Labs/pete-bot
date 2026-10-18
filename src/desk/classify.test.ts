/**
 * Running the classifier (PET-645). A stub stands in for petedio-iac's
 * pr-blast-radius.py, with the same arguments and the same JSON, so the test needs no
 * network. It runs under the real python3, as production does.
 */
import { describe, it, expect } from 'bun:test';
import { classify, type ClassifierSource } from './classify.js';

// Grades .tf and anything under .github as tier 2, .sh as tier 1, the rest tier 0, and
// echoes the workflow files it was handed so the test can see them.
const STUB = `
import json, os, sys
args = sys.argv[1:]
paths = [l.strip() for l in open(args[args.index('--paths-from') + 1]) if l.strip()]
root = args[args.index('--repo-root') + 1]
wfs = sorted(os.listdir(os.path.join(root, '.github', 'workflows')))
def tier(p):
    if p.endswith('.tf') or p.startswith('.github/'): return 2
    if p.endswith('.sh'): return 1
    return 0
rows = [{"path": p, "tier": tier(p), "reason": "stub"} for p in sorted(paths)]
print(json.dumps({"tier": max(r["tier"] for r in rows), "floor_note": None, "paths": rows, "workflows": wfs}))
`;

function source(workflows: Record<string, string> = { 'ci.yml': 'on: push' }, script = STUB): ClassifierSource {
  return { classifier: async () => script, workflows: async () => workflows };
}

describe('classify', () => {
  it('returns the highest tier and the paths at it', async () => {
    const c = await classify('r', [{ path: 'README.md' }, { path: 'a/run.sh' }], source(), 'python3');
    expect(c.tier).toBe(1);
    expect(c.reasons).toEqual(['a/run.sh: stub']);
    expect(c.pathCount).toBe(2);
  });

  it('grades a rename by its old path too', async () => {
    const c = await classify('r', [{ path: 'docs/main.md', previousPath: 'infra/main.tf' }], source(), 'python3');
    expect(c.tier).toBe(2);
    expect(c.pathCount).toBe(2);
  });

  it('writes only safe workflow names', async () => {
    let seen = '';
    await classify('r', [{ path: 'a.md' }], source({ 'ok.yml': 'x', '../escape.yml': 'x', 'notes.txt': 'x' }), 'python3', async (argv) => {
      const proc = Bun.spawn(argv, { stdout: 'pipe' });
      seen = await new Response(proc.stdout).text();
      return { exitCode: await proc.exited, stdout: seen, stderr: '' };
    });
    expect(JSON.parse(seen).workflows).toEqual(['ok.yml']);
  });

  it('fails when the classifier fails', async () => {
    await expect(classify('r', [{ path: 'a.md' }], source({}, 'import sys; sys.exit(3)'), 'python3')).rejects.toThrow('exited 3');
  });

  it('fails when the classifier graded fewer paths than the PR changed', async () => {
    const partial = `import json; print(json.dumps({"tier": 0, "floor_note": None, "paths": []}))`;
    await expect(classify('r', [{ path: 'a.md' }], source({}, partial), 'python3')).rejects.toThrow('graded 0 of 1');
  });

  it('fails on a tier it does not know', async () => {
    const odd = `import json; print(json.dumps({"tier": 3, "floor_note": None, "paths": [{"path": "a.md", "tier": 3, "reason": "x"}]}))`;
    await expect(classify('r', [{ path: 'a.md' }], source({}, odd), 'python3')).rejects.toThrow('tier "3"');
  });

  it('refuses a PR with no files', async () => {
    await expect(classify('r', [], source(), 'python3')).rejects.toThrow('changes no files');
  });
});
