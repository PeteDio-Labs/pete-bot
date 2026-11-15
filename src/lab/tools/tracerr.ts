/**
 * The media tools (PET-869): tracerr's thirteen read-only tools as lab tools, so the media
 * assistant's Qwen loop can ask "where is X stuck" and read the verdict tracerr computed.
 *
 * tracerr picks nothing here. The model picks a tool by its description and tracerr's
 * backend decides the verdict (vault Systems/tracerr.md, "The router picks; the backend
 * decides"), so a wrong answer is an tracerr bug, not a prompt to retune.
 *
 * ⚠ THE ARGUMENT SCHEMAS ARE COPIED FROM media-control/src/tools.ts (skill `tracerr`). They
 * can drift when tracerr changes, so scripts/media-probe.ts compares this list with the live
 * `GET /api/tools` and fails on any difference.
 *
 * ⚠ `{ok:false}` FROM tracerr IS A FINDING, NOT A TOOL FAILURE. tracerr answers HTTP 200 with
 * `{ok:false, error}` when it cannot read a backend ("sonarr is not answering"). The tool
 * returns that text as data so the model reports it. A non-2xx, a non-JSON body or an
 * unreachable tracerr throws, because then tracerr itself did not answer.
 *
 * ⚠ READ-ONLY BY CONSTRUCTION. Only POST /api/tool/<name> for the thirteen names below is
 * called. tracerr has no write tool, and this module has no other route.
 */
import { z } from 'zod';
import { fetchWithTimeout, LabToolError, type LabTool } from './types.js';

export interface TracerrConfig {
  /** Such as http://192.168.50.237:8237 (237 reaches itself through the `lo` allowlist rule). */
  baseUrl: string;
  token: string;
  /** partial_files reads 175 files and took 22 s in MED-3, so the default leaves room. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const title = (required: boolean) => {
  const s = z.string().min(1).max(200).describe('The title, such as "Survivor"');
  return required ? s : s.optional();
};

interface Spec {
  name: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
}

export const TRACERR_SPECS: Spec[] = [
  {
    name: 'library',
    description: 'What is in the library: "do I have X", "how many seasons", "is X complete". With no title, a whole-library summary.',
    input: z.object({ title: title(false) }),
  },
  {
    name: 'trace_request',
    description: 'Where one named title is, and why it is missing or not in Plex. Use it for any named title, even when the question mentions Plex.',
    input: z.object({
      title: title(true),
      season: z.number().int().min(0).max(100).optional(),
      episode: z.number().int().min(0).max(1000).optional(),
    }),
  },
  { name: 'list_queue', description: 'Everything downloading or waiting to import, including torrents added by hand, with progress, speed and ETA, then the latest finished downloads. Use it for "how long until it is downloaded" and "latest downloads".', input: z.object({}) },
  { name: 'queue_errors', description: 'Queue items that fail, block, stick or fail to import, with each message.', input: z.object({}) },
  { name: 'why_is_it_dead', description: 'Why individual torrents do not move: seed counts and tracker messages. Check vpn_health first when everything is at zero seeds.', input: z.object({}) },
  {
    name: 'vpn_health',
    description: "Whether the VPN tunnel is up, whether traffic leaks onto the house IP, and whether the forwarded port matches qBittorrent's. Use it when every download stalls at once.",
    input: z.object({}),
  },
  { name: 'seerr_drift', description: 'What seerr claims against what Sonarr and Radarr hold on disk. The arr apps are ground truth.', input: z.object({}) },
  { name: 'now_playing', description: 'Plex as a whole: who is watching, which libraries exist, whether it answers. Not a title lookup.', input: z.object({}) },
  {
    name: 'pool_health',
    description: 'State of the ZFS pools on pve02 (media and downloads), read from inside the plex guest. Use it when many titles fail to play at once, or to check the pools after the USB enclosure reset. Not for one named title. It reports the pool state, not free space.',
    input: z.object({}),
  },
  {
    name: 'disk_free',
    description: 'Free space on the volumes Sonarr and Radarr can see, such as the library and download disks, with a low or critical verdict. Use it for "how much space is left" and "is the disk full". Not for ZFS pool state and not for one title.',
    input: z.object({}),
  },
  {
    name: 'indexer_health',
    description: "Prowlarr's indexers: which are enabled, which are backed off after failures, and its health warnings. Use it for \"are the indexers working\" and \"why is search returning nothing\". Not for a stuck download.",
    input: z.object({}),
  },
  { name: 'stale_versions', description: 'Which of Sonarr, Radarr and Prowlarr have an update available. It does not cover Plex, qBittorrent, seerr or Bazarr.', input: z.object({}) },
  {
    name: 'partial_files',
    description: 'Imported episode files that are mostly zero bytes. With no title, files Sonarr imported in the last 14 days. It takes about 20 seconds.',
    input: z.object({ title: title(false) }),
  },
];

export function tracerrTools(cfg: TracerrConfig): LabTool[] {
  return TRACERR_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input: spec.input,
    // The model passes `title` to no-argument tools. tracerr is read-only, so drop that key only.
    ...(Object.keys(spec.input.shape).includes('title') ? {} : { ignoredKeys: ['title'] }),
    async run(args: Record<string, unknown>) {
      const url = `${cfg.baseUrl.replace(/\/$/, '')}/api/tool/${spec.name}`;
      const res = await fetchWithTimeout(
        cfg.fetch ?? fetch,
        url,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(args),
          redirect: 'error',
        },
        cfg.timeoutMs ?? 40_000,
        'tracerr',
      );
      if (res.status === 401 || res.status === 403) throw new LabToolError(`tracerr refused the lab-agent token (HTTP ${res.status})`);
      if (res.status === 404) throw new LabToolError(`tracerr has no tool named ${spec.name} (HTTP 404); the tool list has drifted`);
      if (res.status === 502) {
        // tracerr answers 502 with { ok: false, error } when a tool cannot read the stack (PET-638).
        let detail = '';
        try {
          const failed = (await res.json()) as { error?: unknown };
          if (typeof failed?.error === 'string') detail = `: ${failed.error.slice(0, 300)}`;
        } catch {
          // A 502 from a proxy has no JSON body; the status alone is the message.
        }
        throw new LabToolError(`tracerr could not run ${spec.name} (HTTP 502)${detail}`);
      }
      if (!res.ok) throw new LabToolError(`tracerr answered HTTP ${res.status} for ${spec.name}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new LabToolError(`tracerr answered ${spec.name} with a body that is not JSON`);
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new LabToolError(`tracerr answered ${spec.name} with a body that is not an object`);
      const ok = (body as { ok?: unknown }).ok;
      return {
        source: `tracerr ${spec.name}${ok === false ? ' (tracerr reports a finding: ok=false)' : ''}`,
        data: body,
      };
    },
  }));
}

/**
 * The one write lab-agent sends to tracerr: `search_missing` for ONE title, optionally one season and
 * one kind. With `dryRun` it changes nothing and returns what tracerr would do.
 * Only POST /v1/media/act reaches it, after you tapped Confirm. tracerr answers 403 unless this
 * caller is in its MEDIA_CONTROL_WRITERS (petedio-iac mtrace_write_callers); that surfaces here as an error.
 */
export async function searchMissingViaTracerr(cfg: TracerrConfig, title: string, season?: number, opts: { kind?: 'series' | 'movie'; dryRun?: boolean } = {}): Promise<string> {
  if (!title.trim() || title.length > 200) throw new LabToolError('tracerr: the title must be 1 to 200 characters');
  if (season !== undefined && !(Number.isInteger(season) && season >= 0 && season <= 100)) throw new LabToolError('tracerr: season must be a whole number');
  const res = await fetchWithTimeout(
    cfg.fetch ?? fetch,
    `${cfg.baseUrl.replace(/\/$/, '')}/api/tool/search_missing`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title, ...(season !== undefined ? { season } : {}), ...(opts.kind ? { kind: opts.kind } : {}), dry_run: opts.dryRun === true }),
      redirect: 'error',
    },
    cfg.timeoutMs ?? 40_000,
    'tracerr',
  );
  if (res.status === 401) throw new LabToolError('tracerr refused the lab-agent token (HTTP 401)');
  if (res.status === 403) throw new LabToolError('tracerr does not let lab-agent change anything yet: lab-agent is not in its write callers (mtrace_write_callers). Nothing ran.');
  if (!res.ok) {
    // tracerr reports a failed write as HTTP 502 { ok: false, error }. Say why, so the answer can too.
    let why = '';
    try {
      const failed = (await res.json()) as { error?: unknown };
      if (typeof failed?.error === 'string') why = `: ${failed.error.slice(0, 300)}`;
    } catch {
      // A proxy error page has no JSON body; the status alone is the message.
    }
    throw new LabToolError(`tracerr answered HTTP ${res.status} to the search${why}`);
  }
  // tracerr answers { ok, result: { tool, timing, text } } (petedio-media-control src/server.ts report()).
  let body: { ok?: unknown; result?: unknown; error?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new LabToolError('tracerr answered the search with a body that is not JSON');
  }
  if (body.ok === false) throw new LabToolError(`tracerr refused the search: ${String(body.error ?? 'no reason').slice(0, 300)}`);
  if (body.ok !== true) throw new LabToolError('tracerr answered the search without ok:true, so it is not reported as done');
  const inner = body.result as { text?: unknown } | null;
  const text = typeof inner?.text === 'string' ? inner.text : undefined;
  if (!text) throw new LabToolError('tracerr accepted the call but said nothing about what it did, so it is not reported as done');
  // tracerr answers a refusal ("nothing was changed", "did not answer") as an ordinary result, so only its
  // acceptance sentence counts as a search that started.
  // A dry run says what it would do; only a live call must say the app accepted a search.
  if (opts.dryRun) {
    if (!/^Dry run: would ask/i.test(text)) throw new LabToolError(`tracerr would not run the search: ${text.slice(0, 300)}`);
    return text.slice(0, 400);
  }
  if (!/^(Sonarr|Radarr) accepted a search\b/.test(text)) throw new LabToolError(`tracerr did not start the search: ${text.slice(0, 300)}`);
  return text.slice(0, 400);
}
