import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BaseTool } from './BaseTool.js';
import type { ToolSchema, ToolResult } from '../ai/types.js';

const execFileAsync = promisify(execFile);

// Risk tiers — DESTRUCTIVE actions require confirmed: true
type RiskTier = 'READ_ONLY' | 'SAFE_MUTATE' | 'DESTRUCTIVE';

export interface CodeOpsToolArgs {
  action:
    | 'read_file'
    | 'write_file'
    | 'kubectl_get'
    | 'kubectl_describe'
    | 'kubectl_logs'
    | 'kubectl_exec'
    | 'kubectl_apply'
    | 'kubectl_delete'
    | 'gh_pr_list'
    | 'gh_pr_create'
    | 'gh_run_list'
    | 'gh_run_view'
    | 'git_commit'
    | 'git_push';
  // read_file / write_file
  path?: string;
  content?: string;
  // kubectl
  namespace?: string;
  resource?: string;
  name?: string;
  container?: string;
  lines?: number;
  exec_command?: string[];
  // kubectl apply/delete
  manifest_path?: string;
  // gh pr create
  repo?: string;
  title?: string;
  body?: string;
  base?: string;
  head?: string;
  // gh run view
  run_id?: string;
  // git commit
  message?: string;
  paths?: string[];
  // git push
  remote?: string;
  branch?: string;
  // working directory for git commands (default: workspace root)
  cwd?: string;
  // DESTRUCTIVE gate
  confirmed?: boolean;
}

const RISK_MAP: Record<CodeOpsToolArgs['action'], RiskTier> = {
  read_file: 'READ_ONLY',
  write_file: 'DESTRUCTIVE',
  kubectl_get: 'READ_ONLY',
  kubectl_describe: 'READ_ONLY',
  kubectl_logs: 'READ_ONLY',
  kubectl_exec: 'SAFE_MUTATE',
  kubectl_apply: 'DESTRUCTIVE',
  kubectl_delete: 'DESTRUCTIVE',
  gh_pr_list: 'READ_ONLY',
  gh_pr_create: 'DESTRUCTIVE',
  gh_run_list: 'READ_ONLY',
  gh_run_view: 'READ_ONLY',
  git_commit: 'DESTRUCTIVE',
  git_push: 'DESTRUCTIVE',
};

// Allowlist of safe paths for read_file (workspace root and below)
const ALLOWED_READ_PREFIXES = ['/home/pedro/PeteDio-Labs'];

// Hard cap on output to avoid flooding the context window
const MAX_OUTPUT_CHARS = 8000;

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_OUTPUT_CHARS) + `\n… [truncated ${s.length - MAX_OUTPUT_CHARS} chars]`;
}

const WORKSPACE_ROOT = '/home/pedro/PeteDio-Labs';

async function run(cmd: string, args: string[], timeoutMs = 15_000, cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, cwd });
  return { stdout, stderr };
}

export class CodeOpsTool extends BaseTool<CodeOpsToolArgs> {
  readonly name = 'code_ops';

  readonly schema: ToolSchema = {
    name: 'code_ops',
    description:
      'File reads/writes, git operations, kubectl operations, and GitHub CLI commands for code inspection and modification. ' +
      'Risk tiers: READ_ONLY (always allowed), SAFE_MUTATE (caution), DESTRUCTIVE (requires confirmed=true from human). ' +
      'Full self-modification flow: read_file → write_file → git_commit → git_push → gh_pr_create.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Operation to perform',
          enum: [
            'read_file', 'write_file',
            'kubectl_get', 'kubectl_describe', 'kubectl_logs', 'kubectl_exec',
            'kubectl_apply', 'kubectl_delete',
            'gh_pr_list', 'gh_pr_create', 'gh_run_list', 'gh_run_view',
            'git_commit', 'git_push',
          ],
        },
        path: {
          type: 'string',
          description: 'Absolute file path (read_file / write_file). Must be within /home/pedro/PeteDio-Labs.',
        },
        content: {
          type: 'string',
          description: 'File content to write (write_file). Overwrites the file entirely.',
        },
        namespace: {
          type: 'string',
          description: 'Kubernetes namespace',
        },
        resource: {
          type: 'string',
          description: 'Kubernetes resource type (e.g. deployment, pod, service)',
        },
        name: {
          type: 'string',
          description: 'Resource name',
        },
        container: {
          type: 'string',
          description: 'Container name (for kubectl_logs with multi-container pods)',
        },
        lines: {
          type: 'number',
          description: 'Number of log lines to tail (kubectl_logs, default: 100)',
        },
        exec_command: {
          type: 'array',
          description: 'Command array to run inside a pod (kubectl_exec). Example: ["cat", "/etc/config"]',
          items: { type: 'string', description: 'command argument' },
        },
        manifest_path: {
          type: 'string',
          description: 'Path to manifest file (kubectl_apply / kubectl_delete)',
        },
        repo: {
          type: 'string',
          description: 'GitHub repo in owner/repo format (for gh commands, defaults to current dir)',
        },
        title: {
          type: 'string',
          description: 'PR title (gh_pr_create)',
        },
        body: {
          type: 'string',
          description: 'PR body markdown (gh_pr_create)',
        },
        base: {
          type: 'string',
          description: 'Base branch for PR (gh_pr_create, default: main)',
        },
        head: {
          type: 'string',
          description: 'Head branch for PR (gh_pr_create)',
        },
        run_id: {
          type: 'string',
          description: 'GitHub Actions run ID (gh_run_view)',
        },
        message: {
          type: 'string',
          description: 'Commit message (git_commit)',
        },
        paths: {
          type: 'array',
          description: 'Files to stage before committing (git_commit). Defaults to all changes (".") if omitted.',
          items: { type: 'string', description: 'file path relative to cwd' },
        },
        remote: {
          type: 'string',
          description: 'Git remote name (git_push, default: origin)',
        },
        branch: {
          type: 'string',
          description: 'Branch to push (git_push). Uses current branch if omitted.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for git commands (default: /home/pedro/PeteDio-Labs)',
        },
        confirmed: {
          type: 'boolean',
          description: 'Must be true for DESTRUCTIVE actions (write_file, kubectl_apply, kubectl_delete, gh_pr_create, git_commit, git_push). Human must explicitly confirm.',
        },
      },
      required: ['action'],
    },
  };

  async execute(args: CodeOpsToolArgs): Promise<ToolResult> {
    const tier = RISK_MAP[args.action];

    if (tier === 'DESTRUCTIVE' && !args.confirmed) {
      return {
        success: false,
        error: `Action "${args.action}" is DESTRUCTIVE and requires explicit human confirmation. Set confirmed=true after the human approves. risk_tier=DESTRUCTIVE`,
      };
    }

    try {
      switch (args.action) {
        case 'read_file':
          return await this.handleReadFile(args.path);
        case 'write_file':
          return await this.handleWriteFile(args.path, args.content);
        case 'kubectl_get':
          return await this.handleKubectlGet(args.resource, args.namespace, args.name);
        case 'kubectl_describe':
          return await this.handleKubectlDescribe(args.resource, args.namespace, args.name);
        case 'kubectl_logs':
          return await this.handleKubectlLogs(args.namespace, args.name, args.container, args.lines);
        case 'kubectl_exec':
          return await this.handleKubectlExec(args.namespace, args.name, args.exec_command);
        case 'kubectl_apply':
          return await this.handleKubectlApply(args.manifest_path);
        case 'kubectl_delete':
          return await this.handleKubectlDelete(args.resource, args.namespace, args.name, args.manifest_path);
        case 'gh_pr_list':
          return await this.handleGhPrList(args.repo);
        case 'gh_pr_create':
          return await this.handleGhPrCreate(args.repo, args.title, args.body, args.base, args.head);
        case 'gh_run_list':
          return await this.handleGhRunList(args.repo);
        case 'gh_run_view':
          return await this.handleGhRunView(args.run_id, args.repo);
        case 'git_commit':
          return await this.handleGitCommit(args.message, args.paths, args.cwd);
        case 'git_push':
          return await this.handleGitPush(args.remote, args.branch, args.cwd);
        default:
          return { success: false, error: `Unknown action: ${args.action}` };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, error: `code_ops error (${args.action}): ${msg}` };
    }
  }

  // ── READ_ONLY ──────────────────────────────────────────────

  private async handleReadFile(path?: string): Promise<ToolResult> {
    if (!path) return { success: false, error: 'path is required for read_file' };

    const allowed = ALLOWED_READ_PREFIXES.some((prefix) => path.startsWith(prefix));
    if (!allowed) {
      return { success: false, error: `Path "${path}" is outside allowed read area. Only paths under /home/pedro/PeteDio-Labs are permitted.` };
    }

    // Prevent path traversal
    if (path.includes('..')) {
      return { success: false, error: 'Path traversal (../) is not allowed' };
    }

    const content = await readFile(path, 'utf-8');
    return { success: true, action: 'read_file', path, content: truncate(content) };
  }

  private async handleKubectlGet(resource?: string, namespace?: string, name?: string): Promise<ToolResult> {
    if (!resource) return { success: false, error: 'resource is required for kubectl_get' };
    const args = ['get', resource];
    if (name) args.push(name);
    if (namespace) args.push('-n', namespace); else args.push('-A');
    args.push('-o', 'wide');
    const { stdout } = await run('kubectl', args);
    return { success: true, action: 'kubectl_get', resource, namespace, output: truncate(stdout) };
  }

  private async handleKubectlDescribe(resource?: string, namespace?: string, name?: string): Promise<ToolResult> {
    if (!resource || !name) return { success: false, error: 'resource and name are required for kubectl_describe' };
    const args = ['describe', resource, name];
    if (namespace) args.push('-n', namespace);
    const { stdout } = await run('kubectl', args);
    return { success: true, action: 'kubectl_describe', resource, name, output: truncate(stdout) };
  }

  private async handleKubectlLogs(namespace?: string, name?: string, container?: string, lines = 100): Promise<ToolResult> {
    if (!name) return { success: false, error: 'name (pod or deployment) is required for kubectl_logs' };
    const args = ['logs', name, `--tail=${lines}`];
    if (namespace) args.push('-n', namespace);
    if (container) args.push('-c', container);
    const { stdout } = await run('kubectl', args, 30_000);
    return { success: true, action: 'kubectl_logs', name, namespace, output: truncate(stdout) };
  }

  // ── SAFE_MUTATE ────────────────────────────────────────────

  private async handleKubectlExec(namespace?: string, name?: string, execCommand?: string[]): Promise<ToolResult> {
    if (!name) return { success: false, error: 'name (pod) is required for kubectl_exec' };
    if (!execCommand || execCommand.length === 0) return { success: false, error: 'exec_command is required for kubectl_exec' };

    const args = ['exec', name];
    if (namespace) args.push('-n', namespace);
    args.push('--', ...execCommand);
    const { stdout, stderr } = await run('kubectl', args, 30_000);
    return { success: true, action: 'kubectl_exec', name, namespace, command: execCommand, output: truncate(stdout || stderr) };
  }

  // ── DESTRUCTIVE ────────────────────────────────────────────

  private async handleKubectlApply(manifestPath?: string): Promise<ToolResult> {
    if (!manifestPath) return { success: false, error: 'manifest_path is required for kubectl_apply' };
    const { stdout } = await run('kubectl', ['apply', '-f', manifestPath]);
    return { success: true, action: 'kubectl_apply', manifest_path: manifestPath, output: truncate(stdout) };
  }

  private async handleKubectlDelete(resource?: string, namespace?: string, name?: string, manifestPath?: string): Promise<ToolResult> {
    if (manifestPath) {
      const { stdout } = await run('kubectl', ['delete', '-f', manifestPath]);
      return { success: true, action: 'kubectl_delete', manifest_path: manifestPath, output: truncate(stdout) };
    }
    if (!resource || !name) return { success: false, error: 'resource and name (or manifest_path) are required for kubectl_delete' };
    const args = ['delete', resource, name];
    if (namespace) args.push('-n', namespace);
    const { stdout } = await run('kubectl', args);
    return { success: true, action: 'kubectl_delete', resource, name, output: truncate(stdout) };
  }

  private async handleGhPrList(repo?: string): Promise<ToolResult> {
    const args = ['pr', 'list', '--limit', '20', '--json', 'number,title,state,headRefName,baseRefName,createdAt'];
    if (repo) args.push('--repo', repo);
    const { stdout } = await run('gh', args);
    return { success: true, action: 'gh_pr_list', repo, prs: JSON.parse(stdout || '[]') };
  }

  private async handleGhPrCreate(repo?: string, title?: string, body?: string, base = 'main', head?: string): Promise<ToolResult> {
    if (!title) return { success: false, error: 'title is required for gh_pr_create' };
    if (!head) return { success: false, error: 'head branch is required for gh_pr_create' };
    const args = ['pr', 'create', '--title', title, '--base', base, '--head', head];
    if (body) args.push('--body', body);
    if (repo) args.push('--repo', repo);
    const { stdout } = await run('gh', args, 30_000);
    return { success: true, action: 'gh_pr_create', pr_url: stdout.trim() };
  }

  private async handleGhRunList(repo?: string): Promise<ToolResult> {
    const args = ['run', 'list', '--limit', '10', '--json', 'databaseId,name,status,conclusion,headBranch,createdAt'];
    if (repo) args.push('--repo', repo);
    const { stdout } = await run('gh', args);
    return { success: true, action: 'gh_run_list', repo, runs: JSON.parse(stdout || '[]') };
  }

  private async handleGhRunView(runId?: string, repo?: string): Promise<ToolResult> {
    if (!runId) return { success: false, error: 'run_id is required for gh_run_view' };
    const args = ['run', 'view', runId, '--log-failed'];
    if (repo) args.push('--repo', repo);
    const { stdout } = await run('gh', args, 30_000);
    return { success: true, action: 'gh_run_view', run_id: runId, output: truncate(stdout) };
  }

  // ── FILE WRITE ─────────────────────────────────────────────

  private async handleWriteFile(path?: string, content?: string): Promise<ToolResult> {
    if (!path) return { success: false, error: 'path is required for write_file' };
    if (content === undefined) return { success: false, error: 'content is required for write_file' };

    const allowed = ALLOWED_READ_PREFIXES.some((prefix) => path.startsWith(prefix));
    if (!allowed) {
      return { success: false, error: `Path "${path}" is outside allowed write area. Only paths under /home/pedro/PeteDio-Labs are permitted.` };
    }

    if (path.includes('..')) {
      return { success: false, error: 'Path traversal (../) is not allowed' };
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
    return { success: true, action: 'write_file', path, bytes_written: Buffer.byteLength(content, 'utf-8') };
  }

  // ── GIT ────────────────────────────────────────────────────

  private async handleGitCommit(message?: string, paths?: string[], cwd?: string): Promise<ToolResult> {
    if (!message) return { success: false, error: 'message is required for git_commit' };

    const workDir = cwd ?? WORKSPACE_ROOT;
    const stagePaths = paths && paths.length > 0 ? paths : ['.'];

    await run('git', ['add', ...stagePaths], 15_000, workDir);
    const { stdout } = await run('git', ['commit', '-m', message], 15_000, workDir);
    return { success: true, action: 'git_commit', message, paths: stagePaths, output: truncate(stdout) };
  }

  private async handleGitPush(remote = 'origin', branch?: string, cwd?: string): Promise<ToolResult> {
    const workDir = cwd ?? WORKSPACE_ROOT;
    const args = ['push', remote];
    if (branch) args.push(branch);
    const { stdout, stderr } = await run('git', args, 30_000, workDir);
    return { success: true, action: 'git_push', remote, branch, output: truncate(stdout || stderr) };
  }
}

export default new CodeOpsTool();
