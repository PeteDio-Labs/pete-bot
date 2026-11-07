/** Test helper: a throwaway origin repo and a clone of it, built with real git. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runGit } from './git.js';

export interface TestRepo {
  origin: string;
  clone: string;
  commit(files: Record<string, string>, subject: string): Promise<void>;
}

export async function makeTestRepo(): Promise<TestRepo> {
  const root = mkdtempSync(join(tmpdir(), 'lab-git-'));
  const origin = join(root, 'origin');
  const clone = join(root, 'clone');
  mkdirSync(origin);
  await runGit(origin, ['init', '--quiet', '--initial-branch=main']);
  await runGit(origin, ['config', 'user.email', 'test@example.invalid']);
  await runGit(origin, ['config', 'user.name', 'Test']);
  await runGit(origin, ['config', 'commit.gpgsign', 'false']);
  const repo: TestRepo = {
    origin,
    clone,
    async commit(files, subject) {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(origin, path)), { recursive: true });
        writeFileSync(join(origin, path), text);
      }
      await runGit(origin, ['add', '-A']);
      await runGit(origin, ['commit', '--quiet', '-m', subject]);
    },
  };
  await repo.commit({ 'README.md': 'test\n' }, 'Initial commit');
  await runGit(root, ['clone', '--quiet', origin, clone]);
  return repo;
}
