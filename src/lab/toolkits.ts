/**
 * Toolkits: named groups of the media assistant's tools, switched with LAB_MEDIA_TOOLKITS so
 * Qwen can be tried with different tool sets and the routing metrics compared (Pedro,
 * 2026-11-12). Unset means every kit, which is the behaviour before toolkits existed.
 *
 *   LAB_MEDIA_TOOLKITS=core,health
 *
 * ⚠ A KIT NAME THAT IS NOT HERE STOPS STARTUP. A typo must not leave the assistant running
 * with a smaller tool set than the operator asked for and metrics that say nothing is wrong.
 * ⚠ EVERY TOOL BELONGS TO A KIT. A tool in no kit would vanish whenever a subset is chosen,
 * so a test fails when a media tool is added without one.
 */
import type { LabTool } from './tools/types.js';

export const MEDIA_TOOLKITS: Record<string, readonly string[]> = {
  core: ['library', 'trace_request', 'list_queue', 'queue_errors'],
  health: ['vpn_health', 'why_is_it_dead', 'pool_health', 'disk_free', 'indexer_health'],
  audit: ['seerr_drift', 'stale_versions', 'partial_files', 'now_playing'],
  subtitles: ['bazarr_status', 'bazarr_find', 'propose_action'],
  search: ['search_lab'],
};

export const ALL_TOOLKITS = Object.keys(MEDIA_TOOLKITS);

/** Unset or blank selects every kit. Throws on an unknown name, naming the valid ones. */
export function parseToolkits(raw: string | undefined): string[] {
  const names = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return [...ALL_TOOLKITS];
  const unknown = names.filter((n) => !(n in MEDIA_TOOLKITS));
  if (unknown.length) throw new Error(`LAB_MEDIA_TOOLKITS names no such toolkit: ${unknown.join(', ')}. Valid: ${ALL_TOOLKITS.join(', ')}`);
  return [...new Set(names)].sort();
}

export function selectMediaTools(all: readonly LabTool[], kits: readonly string[]): Map<string, LabTool> {
  const wanted = new Set(kits.flatMap((k) => MEDIA_TOOLKITS[k] ?? []));
  return new Map(all.filter((t) => wanted.has(t.name)).map((t) => [t.name, t] as const));
}
