/**
 * Read-only git clones for the lab tools (PET-668): the knowledge vault and the iac repos.
 *
 * EVERY READ COMES FROM THE REMOTE-TRACKING REF, NOT THE WORKING TREE. A fetch updates
 * `refs/remotes/origin/<branch>` and nothing else, so a clone never needs a pull, a merge or
 * a clean tree, and a half-written checkout can't be read. Files come out with `git show`.
 *
 * ⚠ A FAILED FETCH SERVES THE LAST GOOD REF, AND SAYS SO. A stale answer marked stale is
 * more useful than none, but an unmarked one is the bug this lab keeps paying for. So
 * `describe()` names the commit, its date and any fetch failure, and each tool puts that in
 * its `source` line.
 *
 * git runs with an argument array and no shell. Inputs that reach an argument are checked
 * by the tool first, and a `--` separates paths from options.
 */
import type { GitAuth } from './githubToken.js';
import { LabToolError } from './types.js';

export type GitRunner = (dir: string, args: string[], env?: Record<string, string>) => Promise<string>;

const GIT_TIMEOUT_MS = 20_000;

/** Run git in `dir` and return stdout. A non-zero exit throws with git's own stderr. */
export const runGit: GitRunner = async (dir, args, env = {}) => {
  const proc = Bun.spawn(['git', '-C', dir, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env },
  });
  const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args[0]} exited ${code}: ${stderr.trim().split('\n').pop() ?? ''}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
};

export interface CloneState {
  sha: string;
  committedAt: string;
  fetchedAt: string | null;
  fetchError: string | null;
}

export class GitClone {
  private lastFetchMs = 0;
  private fetchedAt: string | null = null;
  private fetchError: string | null = null;
  private auth: GitAuth | null = null;

  constructor(
    readonly name: string,
    readonly dir: string,
    readonly branch = 'main',
    /** Fetch at most this often, so a burst of tool calls costs one fetch. */
    private readonly minFetchIntervalMs = 5 * 60_000,
    private readonly git: GitRunner = runGit,
    private readonly now: () => number = Date.now,
  ) {}

  get ref(): string {
    return `refs/remotes/origin/${this.branch}`;
  }

  /** Authenticate every fetch, for a private repository. Reads never touch the network. */
  useAuth(auth: GitAuth): this {
    this.auth = auth;
    return this;
  }

  /** Fetch the branch unless it was fetched recently. Never throws: a failure is recorded. */
  async refresh(): Promise<void> {
    if (this.now() - this.lastFetchMs < this.minFetchIntervalMs) return;
    this.lastFetchMs = this.now();
    try {
      const env = this.auth ? await this.auth() : undefined;
      await this.git(this.dir, ['fetch', '--quiet', 'origin', `+refs/heads/${this.branch}:${this.ref}`], env);
      this.fetchedAt = new Date(this.now()).toISOString();
      this.fetchError = null;
    } catch (err) {
      this.fetchError = (err as Error).message;
    }
  }

  /** The commit the next read will see. Throws when the clone has no such ref at all. */
  async state(): Promise<CloneState> {
    let line: string;
    try {
      line = (await this.git(this.dir, ['log', '-1', '--format=%H%x1f%cI', this.ref])).trim();
    } catch (err) {
      const why = this.fetchError ?? (err as Error).message;
      throw new LabToolError(`${this.name} clone has no readable ${this.branch} (${why})`);
    }
    const [sha = '', committedAt = ''] = line.split('\x1f');
    return { sha, committedAt, fetchedAt: this.fetchedAt, fetchError: this.fetchError };
  }

  /** One line for a tool's `source`: which commit, and whether it may be stale. */
  static describe(name: string, s: CloneState): string {
    const stale = s.fetchError ? `, STALE: last fetch failed (${s.fetchError})` : '';
    return `${name} at ${s.sha.slice(0, 7)} (${s.committedAt})${stale}`;
  }

  async listFiles(dirPath: string): Promise<string[]> {
    // -z: without it git quotes a non-ASCII name, and the quoted name can't be read back.
    const out = await this.git(this.dir, ['ls-tree', '-z', '--name-only', `${this.ref}:${dirPath}`]);
    return out.split('\0').filter(Boolean);
  }

  async readFile(path: string): Promise<string> {
    return this.git(this.dir, ['show', `${this.ref}:${path}`]);
  }

  async log(args: string[]): Promise<string> {
    return this.git(this.dir, ['log', ...args]);
  }
}
