/**
 * plane_item and plane_projects: Plane work items across projects (PET-672, PET-859).
 *
 * A key such as `FOL-12` names its project by identifier. The client lists the projects once,
 * maps identifier to id, and reads that project's states. A caller never supplies a project
 * UUID. An identifier Plane does not list is an error that names the identifiers it does list,
 * never an empty result.
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
import { z } from "zod";
import { fetchWithTimeout, LabToolError, type LabTool } from "./types.js";

export const MAX_KEYS = 10;
export const KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-\d{1,5}$/;

export interface PlaneProject {
  identifier: string;
  name: string;
  id: string;
}

export interface PlaneConfig {
  /** Such as http://192.168.50.235:8080 */
  baseUrl: string;
  workspace: string;
  /** The project identifiers a caller may read. Any other identifier is refused before Plane is asked. */
  identifiers: string[];
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
const NOT_FOUND = Symbol("not found");

export class PlaneClient {
  private projectIds: Map<string, PlaneProject> | null = null;
  private states = new Map<string, Map<string, string>>();

  constructor(private readonly cfg: PlaneConfig) {
    if (!/^https?:\/\//.test(cfg.baseUrl))
      throw new Error("Plane URL must be http:// or https://");
  }

  private async get(
    path: string,
    allow404 = false,
  ): Promise<unknown | typeof NOT_FOUND> {
    const base = this.cfg.baseUrl.replace(/\/$/, "");
    const res = await fetchWithTimeout(
      this.cfg.fetch ?? fetch,
      `${base}/api/v1/workspaces/${encodeURIComponent(this.cfg.workspace)}${path}`,
      {
        method: "GET",
        headers: { "X-API-Key": this.cfg.token },
        redirect: "error",
      },
      this.cfg.timeoutMs ?? 8_000,
      `Plane ${path}`,
    );
    if (res.status === 404 && allow404) return NOT_FOUND;
    if (res.status === 401 || res.status === 403)
      throw new LabToolError(
        `Plane refused the lab-agent token for ${path} (HTTP ${res.status})`,
      );
    if (!res.ok)
      throw new LabToolError(`Plane ${path} answered HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new LabToolError(
        `Plane ${path} answered with a body that is not JSON`,
      );
    }
  }

  /** Identifier to project, read once. A project created later reads as a miss; refetch once. */
  async projects(refresh = false): Promise<Map<string, PlaneProject>> {
    if (this.projectIds && !refresh) return this.projectIds;
    const body = (await this.get("/projects/?per_page=100")) as
      | { results?: Array<{ id?: string; identifier?: string; name?: string }> }
      | Array<{ id?: string; identifier?: string; name?: string }>;
    const rows = Array.isArray(body) ? body : (body?.results ?? []);
    const map = new Map<string, PlaneProject>();
    for (const r of rows)
      if (r.id && r.identifier && this.cfg.identifiers.includes(r.identifier))
        map.set(r.identifier, {
          identifier: r.identifier,
          name: String(r.name ?? ""),
          id: r.id,
        });
    // With no projects, every key would read as unknown. That is a failed read.
    if (map.size === 0)
      throw new LabToolError(
        `Plane listed none of the allowed projects (${this.cfg.identifiers.join(", ")})`,
      );
    this.projectIds = map;
    return map;
  }

  async project(identifier: string): Promise<PlaneProject> {
    if (!this.cfg.identifiers.includes(identifier)) {
      throw new LabToolError(
        `Project ${identifier} is not readable here; allowed: ${[...this.cfg.identifiers].sort().join(", ")}`,
      );
    }
    const found =
      (await this.projects()).get(identifier) ??
      (await this.projects(true)).get(identifier);
    if (found) return found;
    const known = [...(this.projectIds ?? []).keys()].sort().join(", ");
    throw new LabToolError(
      `Plane has no project with identifier ${identifier}; it lists: ${known}`,
    );
  }

  private async stateNames(
    projectId: string,
    refresh = false,
  ): Promise<Map<string, string>> {
    const cached = this.states.get(projectId);
    if (cached && !refresh) return cached;
    const body = (await this.get(
      `/projects/${projectId}/states/?per_page=100`,
    )) as
      | { results?: Array<{ id?: string; name?: string }> }
      | Array<{ id?: string; name?: string }>;
    const rows = Array.isArray(body) ? body : (body?.results ?? []);
    const map = new Map(
      rows.filter((s) => s.id && s.name).map((s) => [s.id!, s.name!]),
    );
    // With no states, every item would read as an unknown state. That is a failed read.
    if (map.size === 0)
      throw new LabToolError(`Plane listed 0 states for project ${projectId}`);
    this.states.set(projectId, map);
    return map;
  }

  /** Fill the project and state caches once, before the parallel item reads. */
  async warm(keys: string[]): Promise<void> {
    await this.projects();
    await Promise.all(
      [...new Set(keys.map((k) => k.split("-")[0]!))].map(async (identifier) =>
        this.stateNames((await this.project(identifier)).id),
      ),
    );
  }

  async item(key: string): Promise<PlaneItem> {
    const project = await this.project(key.split("-")[0]!);
    const states = await this.stateNames(project.id);
    const got = await this.get(`/work-items/${key}/`, true);
    if (got === NOT_FOUND) return { key, found: false };
    const w = got as {
      id?: string;
      name?: string;
      state?: unknown;
      project?: unknown;
      updated_at?: string;
    } | null;
    if (!w || typeof w !== "object" || !w.id)
      throw new LabToolError(
        `Plane answered ${key} with a body that is not a work item`,
      );
    const ref = (v: unknown) =>
      v && typeof v === "object"
        ? (v as { id?: string }).id
        : (v as string | undefined);
    if (ref(w.project) !== project.id)
      throw new LabToolError(
        `Plane answered ${key} from a project other than ${project.identifier}`,
      );
    const stateId = ref(w.state);
    // A state added or renamed since the cache filled reads as a miss; refetch once.
    const name = stateId
      ? (states.get(stateId) ??
        (await this.stateNames(project.id, true)).get(stateId))
      : undefined;
    // An item whose state Plane does not list is a fault in what was read, not a state.
    if (!name || !w.name)
      throw new LabToolError(
        `Plane answered ${key} with ${!w.name ? "no title" : `state ${stateId ?? "none"} that project ${project.identifier} does not list`}`,
      );
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
      .array(z.string().regex(KEY_PATTERN, "must look like PET-123 or FOL-12"))
      .min(1)
      .max(MAX_KEYS),
  });
  return {
    name: "plane_item",
    description:
      `The title, state and last update of up to ${MAX_KEYS} work items in Plane, by key such as "PET-672" or "FOL-12". ` +
      "The project comes from the key, so you never pass a project id. Use plane_projects to see the identifiers. " +
      "Use it to name the items a git_history result cites.",
    input,
    async run({ keys }: z.infer<typeof input>) {
      const unique = [...new Set(keys)];
      // In parallel, so ten keys cost one timeout, not ten, inside /lab's deadline. The states
      // call goes first so the keys don't each fetch it.
      await plane.warm(unique);
      const items = await Promise.all(unique.map((key) => plane.item(key)));
      const found = items.filter((i) => i.found).length;
      if (found === 0) {
        throw new LabToolError(
          `Plane answered 404 for all ${unique.length} key(s). That means no such item, or Plane has no /work-items/<KEY>/ route; check one known key before trusting it`,
        );
      }
      return {
        source: `${found} of ${unique.length} items found in Plane`,
        data: { items },
      };
    },
  };
}

export function planeProjectsTool(plane: PlaneClient): LabTool {
  const input = z.object({});
  return {
    name: "plane_projects",
    description:
      "The Plane projects this server may read, by identifier, with name and project id. " +
      "Use it to learn which identifiers plane_item accepts.",
    input,
    async run() {
      const projects = [...(await plane.projects()).values()].sort((a, b) =>
        a.identifier.localeCompare(b.identifier),
      );
      return {
        source: `${projects.length} projects listed by Plane`,
        data: { projects },
      };
    },
  };
}
