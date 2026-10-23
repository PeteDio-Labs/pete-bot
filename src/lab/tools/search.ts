/**
 * search_lab: meaning-based search over the vault, Plane, the digest and repo docs (PET-745).
 *
 * Calls petedio-search on ollama-host (`GET /api/search`), which embeds the question on the
 * 1660 SUPER lane and ranks stored chunks. It is read-only, and the caller's bearer travels
 * only to that host (`redirect: 'error'`).
 *
 * WHY IT EXISTS. A small local model reads a handful of retrieved chunks better than it
 * chains many tool calls. The structured tools stay the authority for live state.
 *
 * ⚠ AN EMPTY RESULT IS NOT PROOF OF ABSENCE. `source` says how many chunks came back for what
 * query; a 502 (the embedding lane is down) or any other failure throws, never reads as "no hits".
 */
import { z } from 'zod';
import { fetchWithTimeout, LabToolError, type LabTool } from './types.js';

export const MAX_HITS = 8;
/** Each chunk is cut to this many characters, so a call adds about 1.5k tokens of context. */
export const MAX_CHUNK_CHARS = 700;

export interface SearchConfig {
  /** Such as http://192.168.50.12:8526 */
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface Hit {
  score: number;
  source: string;
  ref: string;
  title: string;
  text: string;
}

export function searchLabTool(cfg: SearchConfig): LabTool {
  const input = z.object({
    query: z.string().min(3).max(300),
    source: z.enum(['vault', 'plane', 'digest', 'repo']).optional(),
    k: z.number().int().min(1).max(MAX_HITS).optional(),
  });
  return {
    name: 'search_lab',
    description:
      'Search the knowledge vault, Plane items, lab digests and repo docs (runbooks, gotchas, host settings) by meaning. ' +
      'Use it to find where something is explained. For live state use the pve and kuma tools. Cite the ref of each hit.',
    input,
    async run({ query, source, k }: z.infer<typeof input>) {
      const url = new URL('/api/search', cfg.baseUrl);
      url.searchParams.set('q', query);
      url.searchParams.set('k', String(k ?? 5));
      if (source) url.searchParams.set('source', source);
      const res = await fetchWithTimeout(
        cfg.fetch ?? fetch,
        url.toString(),
        { method: 'GET', headers: { authorization: `Bearer ${cfg.token}` }, redirect: 'error' },
        cfg.timeoutMs ?? 10_000,
        'petedio-search',
      );
      if (res.status === 401 || res.status === 403) throw new LabToolError(`petedio-search refused the lab-agent token (HTTP ${res.status})`);
      if (res.status === 502) throw new LabToolError('petedio-search answered 502: the embedding lane did not answer');
      if (!res.ok) throw new LabToolError(`petedio-search answered HTTP ${res.status}`);
      let body: { hits?: Hit[] };
      try {
        body = (await res.json()) as { hits?: Hit[] };
      } catch {
        throw new LabToolError('petedio-search answered with a body that is not JSON');
      }
      if (!Array.isArray(body.hits)) throw new LabToolError('petedio-search answered with no hits field');
      return {
        source: `${body.hits.length} chunks from petedio-search for the query${source ? ` (source ${source})` : ''}`,
        data: {
          hits: body.hits.map((h) => ({ ref: h.ref, source: h.source, title: h.title, score: h.score, text: String(h.text).slice(0, MAX_CHUNK_CHARS) })),
        },
      };
    },
  };
}
