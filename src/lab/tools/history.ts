/**
 * git_history: commits in the iac repos, by path or by text (PET-668).
 *
 * It answers "what changed on X, and which PET did it". The PET key comes from the commit
 * subject, since every squash-merge here names one, until PET-672 adds a Plane read.
 */
import { z } from 'zod';
import { GitClone } from './git.js';
import { LabToolError, type LabTool } from './types.js';

export interface Commit {
  sha: string;
  date: string;
  author: string;
  subject: string;
  pet: string[];
}

/** A repo-relative path: no option-looking start, no parent hops, no shell or glob characters. */
const SAFE_PATH = /^(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

export function parseLog(out: string): Commit[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', date = '', author = '', subject = ''] = line.split('\x1f');
      return { sha: sha.slice(0, 7), date, author, subject, pet: [...new Set(subject.match(/\bPET-\d+\b/g) ?? [])] };
    });
}

export function gitHistoryTool(clones: GitClone[]): LabTool {
  const names = clones.map((c) => c.name);
  if (names.length === 0) throw new Error('git_history needs at least one clone');
  const byName = new Map(clones.map((c) => [c.name, c]));
  const input = z.object({
    repo: z.enum(names as [string, ...string[]]).describe('Which repository to read'),
    path: z
      .string()
      .max(200)
      .regex(SAFE_PATH, 'must be a plain repo-relative path')
      .optional()
      .describe('Only commits touching this file or directory, such as "environments/homelab/plane.tf"'),
    text: z
      .string()
      .min(2)
      .max(100)
      .optional()
      .describe('Only commits whose message contains this text, case-insensitive, such as "PET-617" or "plane"'),
    limit: z.number().int().min(1).max(50).default(15).describe('How many commits, newest first'),
  });
  return {
    name: 'git_history',
    description:
      `Recent commits on the default branch of ${names.join(' or ')}, newest first, with any PET keys from ` +
      'each subject. Filter by path, by message text, or both.',
    input,
    async run({ repo, path, text, limit }: z.infer<typeof input>) {
      const clone = byName.get(repo)!;
      await clone.refresh();
      const state = await clone.state();
      const args = [`--max-count=${limit}`, '--format=%H%x1f%cI%x1f%an%x1f%s'];
      if (text) args.push('--regexp-ignore-case', '--fixed-strings', `--grep=${text}`);
      args.push(clone.ref, '--');
      if (path) args.push(path);
      let out: string;
      try {
        out = await clone.log(args);
      } catch (err) {
        throw new LabToolError(`git log in ${repo} failed: ${(err as Error).message}`);
      }
      const commits = parseLog(out);
      const filter = [path && `path ${path}`, text && `text "${text}"`].filter(Boolean).join(', ');
      return {
        source: `${commits.length} commits${filter ? ` matching ${filter}` : ''} from ${GitClone.describe(repo, state)}`,
        data: { commits },
      };
    },
  };
}
