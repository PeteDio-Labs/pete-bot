/**
 * The newest backup copy per guest as the dashboard feed carries it. lab-agent holds the Proxmox read and serves it at
 * GET /v1/backups; this module asks for it, caches the answer briefly, and returns null on any failure, so the feed
 * leaves the section out and the page says it was not read. A failure never becomes an empty list of guests.
 */
export const BACKUPS_CACHE_MS = 120_000;
const TIMEOUT_MS = 8_000;

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type BackupsRead = { ok: true; report: Record<string, unknown> } | { ok: false; why: string };

export async function readBackups(url: string, token: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<BackupsRead> {
  if (!token) return { ok: false, why: 'no token for lab-agent is set' };
  try {
    const r = await fetchFn(`${url.replace(/\/$/, '')}/v1/backups`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return { ok: false, why: `lab-agent answered HTTP ${r.status}` };
    const body = (await r.json()) as { checkedAt?: unknown; guests?: unknown };
    if (typeof body?.checkedAt !== 'string' || !Array.isArray(body.guests)) return { ok: false, why: 'lab-agent answered with a body the feed could not read' };
    return { ok: true, report: body as Record<string, unknown> };
  } catch (err) {
    return { ok: false, why: `lab-agent did not answer (${err instanceof Error ? err.name : 'error'})` };
  }
}

export function cachedBackups(url: string, token: string, log: (msg: string) => void = () => {}, fetchFn?: Fetch): (now: Date) => Promise<Record<string, unknown> | null> {
  let cached: { at: number; value: Record<string, unknown> | null } | null = null;
  return async (now) => {
    if (cached && now.getTime() - cached.at < BACKUPS_CACHE_MS) return cached.value;
    const r = await readBackups(url, token, fetchFn);
    if (!r.ok) log(`backups not read: ${r.why}`);
    cached = { at: now.getTime(), value: r.ok ? r.report : null };
    return cached.value;
  };
}
