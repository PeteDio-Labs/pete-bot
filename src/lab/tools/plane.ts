/**
 * plane_item: the title, state and last update of PET work items (PET-672).
 *
 * Reads the Plane API on 235 (`/api/v1/workspaces/<ws>/work-items/PET-<n>/`) with a
 * read-only token for the Claude Plane user. One call resolves a state UUID to its name,
 * then one call per key reads the item. It makes no write call.
 *
 * ⚠ THE KEY IS NOT READ-ONLY. A Plane key carries its user's permissions, so GET-only is
 * enforced here, in code, and by a test. Keep the Claude Plane user a Member with no admin role.
 * The default URL is cleartext http on the LAN, as plane-sync uses it. The key travels only
 * to that host, and `redirect: 'error'` stops a 3xx from forwarding it elsewhere.
 *
 * ⚠ A KEY THAT FAILS TO READ IS REPORTED, NEVER DROPPED. A 404 is `found: false` for that key.
 * A 404 cannot tell a missing item from a Plane with no identifier route, so when EVERY key
 * answers 404 the call throws instead. Any other answer (401, 5xx, a body that is not a work
 * item) throws too, so a dead token never reads as "these items do not exist". `source` says
 * how many keys were asked for and how many were found.
 *
 * COST. Keys are capped at MAX_KEYS and each item is cut to three fields, so a call adds
 * a few hundred tokens to the model's context. The token is never sent anywhere but Plane.
 */
import { z } from 'zod';
import { fetchWithTimeout, LabToolError, type LabTool } from './types.js';

export const MAX_KEYS = 10;

export interface PlaneConfig {
  /** Such as http://192.168.50.235:8080 */
  baseUrl: string;
  workspace: string;
  /** The PET project's id. A work item from another project is refused. */
  projectId: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface PlaneItem {
  key: string;
  found: boolean;
  title?: string;
  state?: string;
  updated?: string;
}

/** A 404, apart from any JSON body: a 200 with a body of `null` is a fault, not a missing item. */
const NOT_FOUND = Symbol('not found');

export class PlaneClient {
  private states: Map<string, string> | null = null;

  constructor(private readonly cfg: PlaneConfig) {
    if (!/^https?:\/\//.test(cfg.baseUrl)) throw new Error('Plane URL must be http:// or https://');
  }

  private async get(path: string, allow404 = false): Promise<unknown | typeof NOT_FOUND> {
    const base = this.cfg.baseUrl.replace(/\/$/, '');
    const res = await fetchWithTimeout(
      this.cfg.fetch ?? fetch,
      `${base}/api/v1/workspaces/${encodeURIComponent(this.cfg.workspace)}${path}`,
      { method: 'GET', headers: { 'X-API-Key': this.cfg.token }, redirect: 'error' },
      this.cfg.timeoutMs ?? 8_000,
      `Plane ${path}`,
    );
    if (res.status === 404 && allow404) return NOT_FOUND;
    if (res.status === 401 || res.status === 403) throw new LabToolError(`Plane refused the lab-agent token for ${path} (HTTP ${res.status})`);
    if (!res.ok) throw new LabToolError(`Plane ${path} answered HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new LabToolError(`Plane ${path} answered with a body that is not JSON`);
    }
  }

  private async stateNames(refresh = false): Promise<Map<string, string>> {
    if (this.states && !refresh) return this.states;
    const body = (await this.get(`/projects/${this.cfg.projectId}/states/?per_page=100`)) as
      | { results?: Array<{ id?: string; name?: string }> }
      | Array<{ id?: string; name?: string }>;
    const rows = Array.isArray(body) ? body : (body?.results ?? []);
    const map = new Map(rows.filter((s) => s.id && s.name).map((s) => [s.id!, s.name!]));
    // With no states, every item would read as an unknown state. That is a failed read.
    if (map.size === 0) throw new LabToolError('Plane listed 0 states for the PET project');
    this.states = map;
    return map;
  }

  /** Fill the state names once, before the parallel item reads. */
  async warm(): Promise<void> {
    await this.stateNames();
  }

  async item(key: string): Promise<PlaneItem> {
    const states = await this.stateNames();
    const got = await this.get(`/work-items/${key}/`, true);
    if (got === NOT_FOUND) return { key, found: false };
    const w = got as { id?: string; name?: string; state?: unknown; project?: unknown; updated_at?: string } | null;
    if (!w || typeof w !== 'object' || !w.id) throw new LabToolError(`Plane answered ${key} with a body that is not a work item`);
    const ref = (v: unknown) => (v && typeof v === 'object' ? (v as { id?: string }).id : (v as string | undefined));
    if (ref(w.project) !== this.cfg.projectId) throw new LabToolError(`Plane answered ${key} from a project other than PET`);
    const stateId = ref(w.state);
    // A state added or renamed since the cache filled reads as a miss; refetch once.
    const name = stateId ? (states.get(stateId) ?? (await this.stateNames(true)).get(stateId)) : undefined;
    // An item whose state Plane does not list is a fault in what was read, not a state.
    if (!name || !w.name) throw new LabToolError(`Plane answered ${key} with ${!w.name ? 'no title' : `state ${stateId ?? 'none'} that the PET project does not list`}`);
    return {
      key,
      found: true,
      title: String(w.name).slice(0, 200),
      state: name,
      updated: w.updated_at,
    };
  }
}

export function planeItemTool(plane: PlaneClient): LabTool {
  const input = z.object({
    keys: z
      .array(z.string().regex(/^PET-\d{1,5}$/, 'must look like PET-123'))
      .min(1)
      .max(MAX_KEYS),
  });
  return {
    name: 'plane_item',
    description:
      `The title, state and last update of up to ${MAX_KEYS} PET work items in Plane, by key such as "PET-672". ` +
      'Use it to name the items a git_history result cites.',
    input,
    async run({ keys }: z.infer<typeof input>) {
      const unique = [...new Set(keys)];
      // In parallel, so ten keys cost one timeout, not ten, inside /lab's deadline. The states
      // call goes first so the keys don't each fetch it.
      await plane.warm();
      const items = await Promise.all(unique.map((key) => plane.item(key)));
      const found = items.filter((i) => i.found).length;
      if (found === 0) {
        throw new LabToolError(
          `Plane answered 404 for all ${unique.length} key(s). That means no such item, or Plane has no /work-items/PET-<n>/ route; check one known key before trusting it`,
        );
      }
      return {
        source: `${found} of ${unique.length} PET items found in Plane`,
        data: { items },
      };
    },
  };
}
