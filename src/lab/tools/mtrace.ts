/**
 * The media tools (PET-869): mtrace's eleven read-only tools as lab tools, so the media
 * assistant's Qwen loop can ask "where is X stuck" and read the verdict mtrace computed.
 *
 * mtrace picks nothing here. The model picks a tool by its description and mtrace's
 * backend decides the verdict (vault Systems/mtrace.md, "The router picks; the backend
 * decides"), so a wrong answer is an mtrace bug, not a prompt to retune.
 *
 * ⚠ THE ARGUMENT SCHEMAS ARE COPIED FROM media-control/src/tools.ts (skill `mtrace`). They
 * can drift when mtrace changes, so scripts/media-probe.ts compares this list with the live
 * `GET /api/tools` and fails on any difference.
 *
 * ⚠ `{ok:false}` FROM mtrace IS A FINDING, NOT A TOOL FAILURE. mtrace answers HTTP 200 with
 * `{ok:false, error}` when it cannot read a backend ("sonarr is not answering"). The tool
 * returns that text as data so the model reports it. A non-2xx, a non-JSON body or an
 * unreachable mtrace throws, because then mtrace itself did not answer.
 *
 * ⚠ READ-ONLY BY CONSTRUCTION. Only POST /api/tool/<name> for the eleven names below is
 * called. mtrace has no write tool, and this module has no other route.
 */
import { z } from 'zod';
import { fetchWithTimeout, LabToolError, type LabTool } from './types.js';

export interface MtraceConfig {
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

export const MTRACE_SPECS: Spec[] = [
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
  { name: 'stale_versions', description: 'Which of Sonarr, Radarr and Prowlarr have an update available. It does not cover Plex, qBittorrent, seerr or Bazarr.', input: z.object({}) },
  {
    name: 'partial_files',
    description: 'Imported episode files that are mostly zero bytes. With no title, files Sonarr imported in the last 14 days. It takes about 20 seconds.',
    input: z.object({ title: title(false) }),
  },
];

export function mtraceTools(cfg: MtraceConfig): LabTool[] {
  return MTRACE_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input: spec.input,
    // The model passes `title` to no-argument tools. mtrace is read-only, so drop that key only.
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
        'mtrace',
      );
      if (res.status === 401 || res.status === 403) throw new LabToolError(`mtrace refused the lab-agent token (HTTP ${res.status})`);
      if (res.status === 404) throw new LabToolError(`mtrace has no tool named ${spec.name} (HTTP 404); the tool list has drifted`);
      if (!res.ok) throw new LabToolError(`mtrace answered HTTP ${res.status} for ${spec.name}`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new LabToolError(`mtrace answered ${spec.name} with a body that is not JSON`);
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new LabToolError(`mtrace answered ${spec.name} with a body that is not an object`);
      const ok = (body as { ok?: unknown }).ok;
      return {
        source: `mtrace ${spec.name}${ok === false ? ' (mtrace reports a finding: ok=false)' : ''}`,
        data: body,
      };
    },
  }));
}
