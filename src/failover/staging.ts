/**
 * The staging box's 24-hour clock as the dashboard feed carries it. lab-agent holds the Proxmox read and
 * serves it at GET /v1/staging; this module asks for it, caches the answer briefly, and turns every failure
 * into `unknown`, never into an `up` nobody read.
 */
export const STAGING_CACHE_MS = 20_000;
const TIMEOUT_MS = 3_000;

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function readStaging(url: string, token: string, now: Date, fetchFn: Fetch = fetch as unknown as Fetch): Promise<Record<string, unknown>> {
  const unknown = (detail: string) => ({ state: 'unknown', checkedAt: now.toISOString(), detail });
  if (!token) return unknown('no token for lab-agent is set, so the staging clock was not read');
  try {
    const r = await fetchFn(`${url.replace(/\/$/, '')}/v1/staging`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return unknown(`lab-agent answered HTTP ${r.status}`);
    const body = (await r.json()) as unknown;
    if (typeof body !== 'object' || body === null || typeof (body as { state?: unknown }).state !== 'string') return unknown('lab-agent answered with a body the feed could not read');
    // The feed's reader requires a time on every state. A state without one is stamped with the read's own time.
    const b = body as Record<string, unknown>;
    return typeof b.checkedAt === 'string' && b.checkedAt ? b : { ...b, checkedAt: now.toISOString() };
  } catch (err) {
    return unknown(`lab-agent did not answer (${err instanceof Error ? err.name : 'error'})`);
  }
}

export function cachedStaging(url: string, token: string, fetchFn?: Fetch): (now: Date) => Promise<Record<string, unknown>> {
  let cached: { at: number; value: Record<string, unknown> } | null = null;
  return async (now) => {
    if (cached && now.getTime() - cached.at < STAGING_CACHE_MS) return cached.value;
    const value = await readStaging(url, token, now, fetchFn);
    cached = { at: now.getTime(), value };
    return value;
  };
}
