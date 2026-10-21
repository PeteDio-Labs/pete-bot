/**
 * A read-only Plane client for the reports (PET-701). It issues GET requests and nothing
 * else.
 *
 * ⚠ A PARTIAL LIST IS AN ERROR. The list walks Plane's cursor to the end and compares the
 * count with `total_count` when Plane reports one. An audit that read 100 of 403 items would
 * report a clean board.
 *
 * ⚠ fetch HAS NO DEFAULT TIMEOUT. Every call carries one.
 */
import type { PlaneSettings } from './settings.js';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGES = 40;

export interface PlaneItem {
  id: string;
  seq: number;
  name: string;
  stateName: string;
  stateGroup: string;
  labels: string[];
  parent: string | null;
  targetDate: string | null;
  updatedAt: string;
  priority: string;
}

export interface PlaneComment {
  at: string;
  text: string;
}

export type PlaneRead =
  | { ok: true; items: PlaneItem[]; states: number; labels: number }
  | { ok: false; error: string };

export interface PlaneCycle {
  id: string;
  name: string;
  /** YYYY-MM-DD. */
  start: string;
  end: string;
  /** Work item ids in the cycle. `null` when the cycle's items were not read. */
  itemIds: string[] | null;
}

/** The cycles around today. A Monday-to-Sunday cycle covers `today`; `previous` ended before it. */
export type CycleRead =
  | { ok: true; current: PlaneCycle | null; previous: PlaneCycle | null; next: PlaneCycle | null; upcoming: PlaneCycle[]; dated: number; undated: number }
  | { ok: false; error: string };

type Fetch = typeof fetch;

interface RawCycle {
  id: string;
  name?: string;
  start_date?: string | null;
  end_date?: string | null;
}

interface RawState {
  id: string;
  name: string;
  group?: string;
}
interface RawLabel {
  id: string;
  name: string;
}
interface RawItem {
  id: string;
  sequence_id: number;
  name: string;
  state: string | { id: string } | null;
  labels?: (string | { id: string })[];
  parent?: string | { id: string } | null;
  target_date?: string | null;
  updated_at?: string;
  priority?: string | null;
  archived_at?: string | null;
}
interface Page<T> {
  results?: T[];
  next_cursor?: string;
  next_page_results?: boolean;
  total_count?: number;
}

const ref = (v: string | { id: string } | null | undefined): string | null => (typeof v === 'string' ? v : (v?.id ?? null));

export class PlaneClient {
  private readonly fetchImpl: Fetch;

  constructor(
    private readonly s: PlaneSettings,
    fetchImpl: Fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  private projectUrl(path: string): string {
    return `${this.s.baseUrl}/api/v1/workspaces/${this.s.workspace}/projects/${this.s.projectId}/${path}`;
  }

  private async get<T>(what: string, url: string): Promise<T> {
    const res = await this.fetchImpl(url, {
      headers: { 'X-API-Key': this.s.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 120);
      throw new Error(`${what}: Plane answered HTTP ${res.status} ${detail}`.trim());
    }
    return (await res.json()) as T;
  }

  /** Every row of a list route, following the cursor. Accepts a bare array or a page object. */
  private async all<T>(what: string, path: string): Promise<T[]> {
    const out: T[] = [];
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const url = this.projectUrl(`${path}${sep}per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      const body = await this.get<Page<T> | T[]>(what, url);
      if (Array.isArray(body)) return body;
      out.push(...(body.results ?? []));
      if (!body.next_page_results) {
        if (typeof body.total_count === 'number' && body.total_count !== out.length) {
          throw new Error(`${what}: Plane reports ${body.total_count} rows but ${out.length} were read; refusing a partial list`);
        }
        return out;
      }
      if (!body.next_cursor) throw new Error(`${what}: Plane promised another page and gave no cursor`);
      cursor = body.next_cursor;
    }
    throw new Error(`${what}: more than ${MAX_PAGES} pages, refusing to judge a partial list`);
  }

  async read(): Promise<PlaneRead> {
    try {
      const states = await this.all<RawState>('reading states', 'states/');
      const labels = await this.all<RawLabel>('reading labels', 'labels/');
      const raw = await this.all<RawItem>('reading work items', 'work-items/');
      if (raw.length === 0) return { ok: false, error: 'Plane returned no work items, which cannot be a real board' };
      const stateById = new Map(states.map((s) => [s.id, s]));
      const labelById = new Map(labels.map((l) => [l.id, l.name]));
      const items: PlaneItem[] = [];
      for (const r of raw) {
        if (r.archived_at) continue;
        const st = stateById.get(ref(r.state) ?? '');
        if (!st) return { ok: false, error: `PET-${r.sequence_id} has a state this project does not list, so no state name can be trusted` };
        items.push({
          id: r.id,
          seq: r.sequence_id,
          name: r.name,
          stateName: st.name,
          stateGroup: (st.group ?? '').toLowerCase(),
          labels: (r.labels ?? []).map((l) => labelById.get(ref(l) ?? '') ?? '?').filter((n) => n !== '?'),
          parent: ref(r.parent),
          targetDate: r.target_date ?? null,
          updatedAt: r.updated_at ?? '',
          priority: r.priority ?? 'none',
        });
      }
      return { ok: true, items, states: states.length, labels: labels.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The newest comment on one item, tags stripped, or null when it has none. */
  async lastComment(itemId: string): Promise<PlaneComment | null> {
    const rows = await this.all<{ comment_html?: string; comment_stripped?: string; created_at?: string }>(
      'reading comments',
      `work-items/${itemId}/comments/`,
    );
    if (rows.length === 0) return null;
    const newest = rows.reduce((a, b) => ((b.created_at ?? '') > (a.created_at ?? '') ? b : a));
    const text = (newest.comment_stripped ?? newest.comment_html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return { at: newest.created_at ?? '', text };
  }

  /**
   * Cycle dates are UTC wall-clock dates in the cycle's own timezone (live Plane: start
   * "2026-11-02T00:00:01Z", end "2026-11-08T23:59:00Z"), so the first ten characters are the
   * day. A cycle-issues row names its work item in `issue`; a row shaped like a work item
   * (it has `sequence_id`) is that item, and any other row is an error.
   *
   * The cycles around `today` (YYYY-MM-DD, Eastern) and the items of the current and previous
   * one. A cycle read that fails returns an error, and the morning queue says so.
   */
  async cycles(today: string): Promise<CycleRead> {
    try {
      const raw = await this.all<RawCycle>('reading cycles', 'cycles/');
      const dated: PlaneCycle[] = raw
        .filter((c) => c.start_date && c.end_date)
        .map((c) => ({ id: c.id, name: c.name ?? '?', start: c.start_date!.slice(0, 10), end: c.end_date!.slice(0, 10), itemIds: null }))
        .sort((a, b) => b.start.localeCompare(a.start));
      const current = dated.find((c) => c.start <= today && today <= c.end) ?? null;
      const before = dated.filter((c) => c.end < (current?.start ?? today));
      const previous = before.length ? before.reduce((a, b) => (b.end > a.end ? b : a)) : null;
      const after = dated.filter((c) => c.start > today);
      const next = after.length ? after.reduce((a, b) => (b.start < a.start ? b : a)) : null;
      for (const c of [current, previous]) {
        if (!c) continue;
        const rows = await this.all<{ id?: string; issue?: string | { id: string } | null; sequence_id?: number }>('reading cycle items', `cycles/${c.id}/cycle-issues/`);
        const ids = rows.map((r) => ref(r.issue) ?? (r.sequence_id !== undefined ? (r.id ?? null) : null));
        if (ids.some((i) => i === null)) throw new Error(`cycle "${c.name}" has an item row with no work item id (a join row's own id is not the item's)`);
        c.itemIds = ids as string[];
      }
      return { ok: true, current, previous, next, upcoming: after, dated: dated.length, undated: raw.length - dated.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
