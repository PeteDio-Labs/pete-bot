/**
 * Bazarr for the media assistant (PET-869): two reads and one write.
 *
 * `bazarr_status` and `bazarr_find` are read tools the model may call. `searchMissing` is NOT
 * a tool. Only POST /v1/media/act reaches it, after you tapped Confirm in Discord.
 *
 * ⚠ BAZARR'S API NEEDS THE KEY FOR EVERY CALL (401 without it, MED-3), sent as X-API-KEY.
 * The key lives in lab-agent's env and never reaches pete-bot, the model or a log line.
 *
 * ⚠ THE WRITE IS ONE ACTION ON ONE ITEM. `search-missing` on a series id or `search-missing`
 * on a movie id asks the enabled providers for subtitles the item lacks. It deletes and
 * replaces nothing. The id must be a whole number found by bazarr_find, never a title.
 *
 * ⚠ A FAILED CALL IS AN ERROR. A 401, a timeout or a non-JSON body throws, so it never
 * reads as "no subtitles missing". OpenSubtitles.com's free tier stops at 20 downloads a
 * day (vault 222-bazarr), so a search that finds nothing may be a spent quota; status says so.
 */
import { z } from 'zod';
import { fetchWithTimeout, LabToolError, type LabTool } from './types.js';

export interface BazarrConfig {
  /** Such as http://192.168.50.222:6767 */
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export type BazarrKind = 'series' | 'movie';

async function get(cfg: BazarrConfig, path: string): Promise<unknown> {
  const res = await fetchWithTimeout(
    cfg.fetch ?? fetch,
    `${cfg.baseUrl.replace(/\/$/, '')}${path}`,
    { method: 'GET', headers: { 'x-api-key': cfg.apiKey }, redirect: 'error' },
    cfg.timeoutMs ?? 15_000,
    'bazarr',
  );
  if (res.status === 401 || res.status === 403) throw new LabToolError(`bazarr refused the lab-agent key (HTTP ${res.status})`);
  if (!res.ok) throw new LabToolError(`bazarr answered HTTP ${res.status} for ${path.split('?')[0]}`);
  try {
    return await res.json();
  } catch {
    throw new LabToolError(`bazarr answered ${path.split('?')[0]} with a body that is not JSON`);
  }
}

interface Item {
  kind: BazarrKind;
  id: number;
  title: string;
  missing: number;
}

function rows(body: unknown, what: string): Array<Record<string, unknown>> {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new LabToolError(`bazarr answered ${what} with no data list`);
  return data as Array<Record<string, unknown>>;
}

/** Every series and movie, with its missing-subtitle count. Bazarr holds under 200 here. */
export async function listItems(cfg: BazarrConfig): Promise<Item[]> {
  const [series, movies] = await Promise.all([get(cfg, '/api/series?start=0&length=-1'), get(cfg, '/api/movies?start=0&length=-1')]);
  const out: Item[] = [];
  for (const r of rows(series, '/api/series')) {
    if (typeof r.sonarrSeriesId === 'number' && typeof r.title === 'string') {
      out.push({ kind: 'series', id: r.sonarrSeriesId, title: r.title, missing: Number(r.episodeMissingCount ?? 0) });
    }
  }
  for (const r of rows(movies, '/api/movies')) {
    if (typeof r.radarrId === 'number' && typeof r.title === 'string') {
      out.push({ kind: 'movie', id: r.radarrId, title: r.title, missing: Array.isArray(r.missing_subtitles) ? r.missing_subtitles.length : 0 });
    }
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function matchTitle(items: Item[], query: string): Item[] {
  const q = norm(query);
  if (!q) return [];
  const exact = items.filter((i) => norm(i.title) === q);
  return exact.length ? exact : items.filter((i) => norm(i.title).includes(q));
}

export function bazarrFindTool(cfg: BazarrConfig): LabTool {
  const input = z.object({ title: z.string().min(2).max(200).describe('Part or all of the title, such as "Survivor"') });
  return {
    name: 'bazarr_find',
    description: 'Find a series or movie in Bazarr and see how many subtitles it is missing. Use it before proposing a subtitle search.',
    input,
    async run({ title }: z.infer<typeof input>) {
      const items = await listItems(cfg);
      const hits = matchTitle(items, title).slice(0, 10);
      return { source: `${items.length} titles read from Bazarr, ${hits.length} match "${title.slice(0, 60)}"`, data: { matches: hits } };
    },
  };
}

export function bazarrStatusTool(cfg: BazarrConfig): LabTool {
  const input = z.object({});
  return {
    name: 'bazarr_status',
    description: 'Bazarr health: its problems, how many episodes and movies lack subtitles, and whether a subtitle provider is throttled.',
    input,
    async run() {
      const [badges, health, providers] = await Promise.all([get(cfg, '/api/badges'), get(cfg, '/api/system/health'), get(cfg, '/api/providers')]);
      return {
        source: 'Bazarr /api/badges, /api/system/health and /api/providers',
        data: { badges, health, providers },
      };
    },
  };
}

/** The write. Only the confirmed action route calls this. */
export async function searchMissing(cfg: BazarrConfig, kind: BazarrKind, id: number): Promise<string> {
  if (!Number.isInteger(id) || id < 0) throw new LabToolError('bazarr: the id must be a whole number');
  const body = new URLSearchParams(kind === 'series' ? { seriesid: String(id), action: 'search-missing' } : { radarrid: String(id), action: 'search-missing' });
  const res = await fetchWithTimeout(
    cfg.fetch ?? fetch,
    `${cfg.baseUrl.replace(/\/$/, '')}/api/${kind === 'series' ? 'series' : 'movies'}`,
    {
      method: 'PATCH',
      headers: { 'x-api-key': cfg.apiKey, 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
    },
    cfg.timeoutMs ?? 15_000,
    'bazarr',
  );
  if (res.status === 401 || res.status === 403) throw new LabToolError(`bazarr refused the lab-agent key (HTTP ${res.status})`);
  // 204 is Bazarr's accepted answer: the search runs in its own task queue.
  if (res.status !== 204 && !res.ok) throw new LabToolError(`bazarr answered HTTP ${res.status} to the subtitle search`);
  return `Bazarr accepted the search (HTTP ${res.status}). It runs in Bazarr's task queue; new subtitles land beside the media and Bazarr refreshes Plex after each one.`;
}
