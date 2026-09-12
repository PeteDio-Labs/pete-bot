/**
 * GitHub Actions client for /update (PET-395): start a media update, then read back what
 * the run did.
 *
 * ⚠ THIS PROCESS HOLDS NO ACCESS TO THE MEDIA HOSTS, BY DESIGN. It starts
 * petedio-media-iac's media-updates.yml; that run mints a Vault role bound to that one
 * workflow and runs Ansible from a homelab runner. The token here can run workflows in
 * that one repo and nothing else, so a compromised bot can start an update — which the
 * update's own guards still gate — but cannot reach a host. media-iac's
 * docs/DASHBOARD-BACKEND.md records the design this follows.
 *
 * ⚠ THE DISPATCH API RETURNS NO RUN ID. The caller mints a request id, the workflow echoes
 * it into its run name, and findRun() matches on that. A run that never appears comes back
 * as exactly that, never as a success nobody saw.
 */
import { config } from '../config.js';

/** Mirrors the workflow's `target` choice input. Keep the two in step. */
export const UPDATE_TARGETS = ['plex', 'sonarr', 'radarr', 'prowlarr', 'arr', 'plex-and-arr'] as const;
export type UpdateTarget = (typeof UPDATE_TARGETS)[number];
export type UpdateMode = 'check' | 'apply';

/** Printed by media-updates.yml around the report. Keep in step with that file. */
export const REPORT_BEGIN = '===== MEDIA UPDATE REPORT BEGIN =====';
export const REPORT_END = '===== MEDIA UPDATE REPORT END =====';

const API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 15_000;

export interface RunRef {
  id: number;
  url: string;
}

export type UpdateOutcome =
  | { kind: 'completed'; conclusion: string; url: string; report?: string; reportError?: string }
  | { kind: 'not-found'; requestId: string; url: string }
  | { kind: 'timeout'; url: string };

export interface RunUpdateOptions {
  /** Called once the run is found, so the caller can show its link while it runs. */
  onStarted?: (run: RunRef) => Promise<void> | void;
  /** Injected by tests; defaults to real waiting and a fresh request id. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  requestId?: string;
}

function workflowPath(): string {
  return `/repos/${config.updates.repo}/actions/workflows/${config.updates.workflow}`;
}

async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.updates.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pete-bot',
      ...(init.headers as Record<string, string> | undefined),
    },
    // ⚠ fetch has NO default timeout. A stalled API call would hang the command forever.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function fail(what: string, res: Response): Promise<never> {
  const body = await res.text().catch(() => '');
  throw new Error(`${what} failed: GitHub answered HTTP ${res.status} ${body.slice(0, 200)}`.trim());
}

export function newRequestId(now = Date.now()): string {
  return `pb-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function dispatch(
  mode: UpdateMode,
  target: UpdateTarget,
  force: boolean,
  requestId: string,
): Promise<void> {
  const res = await gh(`${workflowPath()}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ref: 'main',
      inputs: { mode, target, force: force ? 'true' : 'false', request_id: requestId },
    }),
  });
  if (res.status !== 204 && res.status !== 200) await fail('Starting the update', res);
}

export async function findRun(requestId: string): Promise<RunRef | undefined> {
  const res = await gh(`${workflowPath()}/runs?event=workflow_dispatch&per_page=20`);
  if (!res.ok) await fail('Listing runs', res);
  const data = (await res.json()) as {
    workflow_runs?: Array<{ id: number; html_url: string; display_title?: string }>;
  };
  const run = data.workflow_runs?.find((r) => (r.display_title ?? '').includes(`[${requestId}]`));
  return run ? { id: run.id, url: run.html_url } : undefined;
}

export async function getRun(id: number): Promise<{ status: string; conclusion: string | null }> {
  const res = await gh(`/repos/${config.updates.repo}/actions/runs/${id}`);
  if (!res.ok) await fail('Reading the run', res);
  const data = (await res.json()) as { status: string; conclusion: string | null };
  return { status: data.status, conclusion: data.conclusion };
}

/**
 * The run's job log, as text.
 *
 * ⚠ THE LOG ENDPOINT REDIRECTS TO A SIGNED BLOB URL, AND THE TOKEN MUST NOT GO THERE.
 * The redirect is taken by hand so the second request carries no Authorization header.
 */
export async function jobLog(runId: number): Promise<string> {
  const jobsRes = await gh(`/repos/${config.updates.repo}/actions/runs/${runId}/jobs`);
  if (!jobsRes.ok) await fail('Listing the jobs', jobsRes);
  const job = ((await jobsRes.json()) as { jobs?: Array<{ id: number }> }).jobs?.[0];
  if (!job) throw new Error('The run has no job to read');

  const res = await gh(`/repos/${config.updates.repo}/actions/jobs/${job.id}/logs`, { redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (!location) throw new Error('GitHub redirected the log without a location');
    const blob = await fetch(location, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!blob.ok) await fail('Downloading the log', blob);
    return blob.text();
  }
  if (!res.ok) await fail('Reading the log', res);
  return res.text();
}

/** The report the workflow printed between its markers. Job-log lines carry a timestamp. */
export function extractReport(log: string): string | undefined {
  const lines = log
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/, ''));
  const begin = lines.findIndex((line) => line.trim() === REPORT_BEGIN);
  if (begin < 0) return undefined;
  const end = lines.findIndex((line, i) => i > begin && line.trim() === REPORT_END);
  if (end < 0) return undefined;
  return lines.slice(begin + 1, end).join('\n').replace(/\s+$/, '');
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Dispatch, find the run, wait for it, read its report.
 *
 * Every way out says what happened. None reports success without a completed run whose
 * conclusion GitHub gave as success: a run that never appears, or never finishes, comes
 * back as exactly that.
 */
export async function runUpdate(
  mode: UpdateMode,
  target: UpdateTarget,
  force: boolean,
  opts: RunUpdateOptions = {},
): Promise<UpdateOutcome> {
  const sleep = opts.sleep ?? wait;
  const now = opts.now ?? Date.now;
  const requestId = opts.requestId ?? newRequestId(now());
  const runsPage = `https://github.com/${config.updates.repo}/actions/workflows/${config.updates.workflow}`;

  await dispatch(mode, target, force, requestId);

  const findDeadline = now() + config.updates.findTimeoutMs;
  let run = await findRun(requestId);
  while (!run) {
    if (now() >= findDeadline) return { kind: 'not-found', requestId, url: runsPage };
    await sleep(Math.min(3_000, config.updates.pollMs));
    run = await findRun(requestId);
  }

  try {
    await opts.onStarted?.(run);
  } catch {
    // Showing the link is a courtesy. Failing to show it must not stop the follow-up.
  }

  const runDeadline = now() + config.updates.runTimeoutMs;
  for (;;) {
    const { status, conclusion } = await getRun(run.id);
    if (status === 'completed') {
      try {
        const report = extractReport(await jobLog(run.id));
        return { kind: 'completed', conclusion: conclusion ?? 'unknown', url: run.url, report };
      } catch (err) {
        const reportError = err instanceof Error ? err.message : String(err);
        return { kind: 'completed', conclusion: conclusion ?? 'unknown', url: run.url, reportError };
      }
    }
    if (now() >= runDeadline) return { kind: 'timeout', url: run.url };
    await sleep(config.updates.pollMs);
  }
}
