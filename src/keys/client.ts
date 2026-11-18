/**
 * The key manager's GitHub client (dashboard Secrets screen). It starts petedio-iac's keys.yml and reads the run back.
 *
 * ⚠ THIS PROCESS NEVER SEES A KEY. keys.yml runs on the lab runner, writes to Vault and Cloudflare after Pedro's
 * lab-write tap, and prints names, owners and dates only. pete-bot learns a run's state and, for `list`, that log.
 *
 * ⚠ A GITHUB TOKEN CANNOT BE LIMITED TO ONE WORKFLOW. So the workflow name is fixed here, the actions are a closed
 * list, and a name must match the agent-name pattern. Every write still waits on the lab-write tap.
 *
 * ⚠ THE DISPATCH API RETURNS NO RUN ID. The caller mints a request id, keys.yml echoes it into its run name, and
 * findRun() matches on it. A run that never appears comes back as exactly that.
 */
export const KEY_ACTIONS = ['list', 'sync', 'rotate', 'renew', 'reissue'] as const;
export type KeyAction = (typeof KEY_ACTIONS)[number];
/** Actions that name one agent. Keep in step with keys.yml. */
export const NAMED_ACTIONS: readonly KeyAction[] = ['rotate', 'renew', 'reissue'];
export const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
export const REQUEST_ID_RE = /^pb-[a-z0-9]{1,12}-[a-z0-9]{6}$/;

export interface KeysConfig {
  token: string;
  repo: string;
  workflow: string;
}

export interface RunRef {
  id: number;
  url: string;
  status: string;
  conclusion: string | null;
}

const API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;

export function newRequestId(now = Date.now()): string {
  return `pb-${now.toString(36)}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

export function createKeysClient(cfg: KeysConfig, fetchImpl: typeof fetch = fetch) {
  const wf = `/repos/${cfg.repo}/actions/workflows/${cfg.workflow}`;
  const gh = (path: string, init: RequestInit = {}) =>
    fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pete-bot',
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  const fail = async (what: string, res: Response): Promise<never> => {
    const body = await res.text().catch(() => '');
    throw new Error(`${what} failed: GitHub answered HTTP ${res.status} ${body.slice(0, 120)}`.trim());
  };

  return {
    async dispatch(action: KeyAction, name: string | undefined, requestId: string): Promise<void> {
      if (!KEY_ACTIONS.includes(action)) throw new Error('unknown action');
      if (NAMED_ACTIONS.includes(action) ? !name || !NAME_RE.test(name) : !!name) throw new Error('the action and the name do not agree');
      if (!REQUEST_ID_RE.test(requestId)) throw new Error('bad request id');
      const res = await gh(`${wf}/dispatches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs: { action, name: name ?? '', pet: '', request_id: requestId } }),
      });
      if (res.status !== 204 && res.status !== 200) await fail('Starting keys.yml', res);
    },

    async findRun(requestId: string): Promise<RunRef | undefined> {
      if (!REQUEST_ID_RE.test(requestId)) return undefined;
      const res = await gh(`${wf}/runs?event=workflow_dispatch&per_page=30`);
      if (!res.ok) await fail('Listing runs', res);
      const data = (await res.json()) as { workflow_runs?: Array<{ id: number; html_url: string; status: string; conclusion: string | null; display_title?: string }> };
      const r = data.workflow_runs?.find((x) => (x.display_title ?? '').includes(`[${requestId}]`));
      return r ? { id: r.id, url: r.html_url, status: r.status, conclusion: r.conclusion } : undefined;
    },

    /** The first job's log, as text. The log endpoint redirects to a signed blob URL, and the token must not go there. */
    async jobLog(runId: number): Promise<string> {
      const jobsRes = await gh(`/repos/${cfg.repo}/actions/runs/${runId}/jobs`);
      if (!jobsRes.ok) await fail('Listing the jobs', jobsRes);
      const job = ((await jobsRes.json()) as { jobs?: Array<{ id: number }> }).jobs?.[0];
      if (!job) throw new Error('The run has no job to read');
      const res = await gh(`/repos/${cfg.repo}/actions/jobs/${job.id}/logs`, { redirect: 'manual' });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error('GitHub redirected the log without a location');
        const blob = await fetchImpl(location, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!blob.ok) await fail('Downloading the log', blob);
        return blob.text();
      }
      if (!res.ok) await fail('Reading the log', res);
      return res.text();
    },
  };
}
export type KeysClient = ReturnType<typeof createKeysClient>;
