/**
 * Builds the dashboard's `services` rows from the registry and a live read of each lab side.
 * Every lab reading is fetched now (cached for CACHE_MS so a polling page cannot hammer a host);
 * a service with no `labUrl` has none, and the cloud side has no watchdog yet.
 */
import { REGISTRY, type RegistryEntry } from './registry.js';

export const CACHE_MS = 20_000;
const TIMEOUT_MS = 3_000;

export interface SideStatus { ok: boolean; checkedAt: string; detail: string; lagS: number | null }
export interface ServiceRow {
  name: string;
  hostname: string;
  active: 'lab' | 'cloud';
  dataClass: RegistryEntry['dataClass'];
  pinned: boolean;
  auto: boolean;
  lab: SideStatus | null;
  cloud: SideStatus | null;
}

type Fetch = (url: string, init: { signal: AbortSignal; redirect: 'manual' }) => Promise<{ status: number }>;

export async function readLab(e: RegistryEntry, fetchFn: Fetch, now: Date): Promise<SideStatus | null> {
  if (!e.labUrl) return null;
  const checkedAt = now.toISOString();
  try {
    const r = await fetchFn(e.labUrl, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
    // A redirect (a login page in front of the health URL) proves nothing about the service.
    if (r.status >= 300 && r.status < 400) return null;
    return { ok: r.status >= 200 && r.status < 300, checkedAt, detail: `HTTP ${r.status} from the health URL`, lagS: null };
  } catch (err) {
    return { ok: false, checkedAt, detail: `no answer (${err instanceof Error ? err.name : 'error'})`, lagS: null };
  }
}

export async function buildServices(now: Date, fetchFn: Fetch = fetch as unknown as Fetch, registry: readonly RegistryEntry[] = REGISTRY): Promise<ServiceRow[]> {
  const labs = await Promise.all(registry.map((e) => readLab(e, fetchFn, now)));
  return registry.map((e, i) => ({ name: e.name, hostname: e.hostname, active: 'lab', dataClass: e.dataClass, pinned: e.pinned, auto: false, lab: labs[i] ?? null, cloud: null }));
}

let cached: { at: number; rows: ServiceRow[] } | null = null;
export async function cachedServices(now: Date): Promise<ServiceRow[]> {
  if (cached && now.getTime() - cached.at < CACHE_MS) return cached.rows;
  const rows = await buildServices(now);
  cached = { at: now.getTime(), rows };
  return rows;
}

/**
 * Public sites the lab does not run, such as the portfolio on S3 and CloudFront. They have no switch: a site row only says
 * whether the address answers. Staging answers from the lab network; a redirect to a login reads as unknown, never as up.
 */
export interface SiteEntry { name: string; env: 'production' | 'staging'; url: string }
export interface SiteRow extends SiteEntry { reading: SideStatus | null }

export const SITES: readonly SiteEntry[] = [
  { name: 'Portfolio', env: 'production', url: 'https://pdlab.dev/' },
  { name: 'Portfolio', env: 'staging', url: 'https://staging.pdlab.dev/' },
];

export async function buildSites(now: Date, fetchFn: Fetch = fetch as unknown as Fetch, sites: readonly SiteEntry[] = SITES): Promise<SiteRow[]> {
  const readings = await Promise.all(sites.map((e) => readLab({ name: e.name, hostname: e.url, dataClass: 'stateless', pinned: true, labUrl: e.url }, fetchFn, now)));
  return sites.map((e, i) => ({ ...e, reading: readings[i] ?? null }));
}

let cachedSiteRows: { at: number; rows: SiteRow[] } | null = null;
export async function cachedSites(now: Date): Promise<SiteRow[]> {
  if (cachedSiteRows && now.getTime() - cachedSiteRows.at < CACHE_MS) return cachedSiteRows.rows;
  const rows = await buildSites(now);
  cachedSiteRows = { at: now.getTime(), rows };
  return rows;
}
