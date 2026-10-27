/**
 * The daily CVE check (PET-770): the homelab's package inventory against OSV and CISA KEV.
 *
 * The inventory is a JSON snapshot that `ansible/playbooks/collect-cve-inventory.yml` in
 * petedio-iac writes. This file only reads it, so a bot on 237 needs no SSH to any host.
 *
 * ⚠ A CLEAN REPORT MUST SAY WHAT IT EXAMINED. "0 findings" after matching 4000 packages and
 * "0 findings" because the snapshot held no hosts must not look alike. A host the collector
 * could not read is listed as unscanned, never counted as clean. A feed that cannot be read
 * marks the report INCOMPLETE; a feed the matching depends on (OSV) throws, so the runner
 * sends a failure DM and the check never reports a green it did not earn.
 *
 * ⚠ fetch HAS NO DEFAULT TIMEOUT. Every call carries one.
 *
 * Container images are listed, not matched: OSV has no image scanner, and the report says so.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { clip } from './snapshot.js';

export const OSV_BASE = 'https://api.osv.dev';
export const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const TIMEOUT_MS = 20_000;
const BATCH = 500;
const DETAIL_CAP = 400;
const DETAIL_CONCURRENCY = 8;
export const STALE_SNAPSHOT_HOURS = 36;
export const REPORT_CAP = 15;

const HostSchema = z.object({
  name: z.string().min(1),
  address: z.string().optional(),
  ok: z.boolean(),
  error: z.string().optional(),
  os: z.object({ id: z.string(), version: z.string() }).optional(),
  packages: z.array(z.object({ name: z.string(), version: z.string(), source: z.string().optional() })).default([]),
  images: z.array(z.object({ ref: z.string() })).default([]),
  /** A pinned binary with its OSV identity, e.g. cloudflared as Go `github.com/cloudflare/cloudflared`. */
  apps: z.array(z.object({ name: z.string(), version: z.string(), ecosystem: z.string(), package: z.string() })).default([]),
});
const SnapshotSchema = z.object({ generatedAt: z.string(), hosts: z.array(HostSchema) });
export type HostInventory = z.infer<typeof HostSchema>;
export type InventorySnapshot = z.infer<typeof SnapshotSchema>;

export function parseSnapshot(raw: string): InventorySnapshot {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`the inventory snapshot is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = SnapshotSchema.safeParse(json);
  if (!parsed.success) throw new Error(`the inventory snapshot has the wrong shape: ${parsed.error.issues[0]?.message ?? 'unknown'} at ${parsed.error.issues[0]?.path.join('.')}`);
  if (Number.isNaN(Date.parse(parsed.data.generatedAt))) throw new Error('the inventory snapshot has no valid generatedAt');
  return parsed.data;
}

export function readSnapshot(path: string): InventorySnapshot {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`the inventory snapshot cannot be read at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseSnapshot(raw);
}

type Fetch = typeof fetch;

async function json<T>(f: Fetch, what: string, url: string, init?: RequestInit): Promise<T> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface Query {
  ecosystem: string;
  name: string;
  version: string;
  /** Host names that run this exact package and version. */
  hosts: Set<string>;
  /** Binary package names behind a Debian source package, for the upgrade command. */
  binaries: Set<string>;
}

/** The OSV queries for the hosts the collector read, deduplicated across hosts. */
export function buildQueries(snap: InventorySnapshot): Query[] {
  const map = new Map<string, Query>();
  const add = (ecosystem: string, name: string, version: string, host: string, binary?: string): void => {
    const key = `${ecosystem}\u0000${name}\u0000${version}`;
    const q = map.get(key) ?? { ecosystem, name, version, hosts: new Set(), binaries: new Set() };
    q.hosts.add(host);
    if (binary) q.binaries.add(binary);
    map.set(key, q);
  };
  for (const h of snap.hosts) {
    if (!h.ok) continue;
    const eco = h.os?.id === 'debian' ? `Debian:${h.os.version.split('.')[0]}` : null;
    if (eco) {
      for (const p of h.packages) add(eco, (p.source ?? p.name).split(' ')[0]!, p.version, h.name, p.name);
    }
    for (const a of h.apps) add(a.ecosystem, a.package, a.version, h.name, a.name);
  }
  return [...map.values()];
}

interface OsvBatchResponse {
  results: { vulns?: { id: string }[]; next_page_token?: string }[];
}

export interface OsvMatch {
  query: Query;
  ids: string[];
}

export async function queryOsv(f: Fetch, queries: Query[]): Promise<{ matches: OsvMatch[]; truncated: number }> {
  const matches: OsvMatch[] = [];
  let truncated = 0;
  for (let i = 0; i < queries.length; i += BATCH) {
    const slice = queries.slice(i, i + BATCH);
    const body = { queries: slice.map((q) => ({ package: { name: q.name, ecosystem: q.ecosystem }, version: q.version })) };
    const res = await json<OsvBatchResponse>(f, 'OSV querybatch', `${OSV_BASE}/v1/querybatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!Array.isArray(res.results) || res.results.length !== slice.length) throw new Error('OSV querybatch returned a different number of results than queries');
    res.results.forEach((r, j) => {
      if (r.next_page_token) truncated++;
      const ids = (r.vulns ?? []).map((v) => v.id);
      if (ids.length) matches.push({ query: slice[j]!, ids });
    });
  }
  return { matches, truncated };
}

interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  database_specific?: { severity?: string };
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { events?: { fixed?: string }[] }[] }[];
}

export interface Advisory {
  id: string;
  cves: string[];
  summary: string;
  severity: 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW' | 'unrated';
  /** Fixed version per `ecosystem|package`. */
  fixed: Map<string, string>;
}

const SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MODERATE', 'LOW']);

export function toAdvisory(v: OsvVuln): Advisory {
  const sev = (v.database_specific?.severity ?? '').toUpperCase();
  const fixed = new Map<string, string>();
  for (const a of v.affected ?? []) {
    const fix = a.ranges?.flatMap((r) => r.events ?? []).find((e) => e.fixed)?.fixed;
    if (fix && a.package?.name && a.package.ecosystem) fixed.set(`${a.package.ecosystem}|${a.package.name}`, fix);
  }
  return {
    id: v.id,
    cves: [v.id, ...(v.aliases ?? [])].filter((x) => /^CVE-\d{4}-\d+$/.test(x)),
    summary: v.summary ?? '',
    severity: SEVERITIES.has(sev) ? (sev as Advisory['severity']) : 'unrated',
    fixed,
  };
}

export async function fetchAdvisories(f: Fetch, ids: string[]): Promise<{ byId: Map<string, Advisory>; failed: string[]; skipped: number }> {
  const byId = new Map<string, Advisory>();
  const failed: string[] = [];
  const todo = ids.slice(0, DETAIL_CAP);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const id = todo[next++]!;
      try {
        byId.set(id, toAdvisory(await json<OsvVuln>(f, `OSV ${id}`, `${OSV_BASE}/v1/vulns/${encodeURIComponent(id)}`)));
      } catch {
        failed.push(id);
      }
    }
  };
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));
  return { byId, failed, skipped: Math.max(0, ids.length - DETAIL_CAP) };
}

export async function fetchKev(f: Fetch): Promise<Set<string>> {
  const res = await json<{ vulnerabilities?: { cveID: string }[] }>(f, 'CISA KEV', KEV_URL);
  if (!Array.isArray(res.vulnerabilities) || res.vulnerabilities.length === 0) throw new Error('CISA KEV: the catalog held no entries');
  return new Set(res.vulnerabilities.map((v) => v.cveID));
}

export interface Finding {
  /** Stable across days, so a filed item is not filed twice. */
  key: string;
  ecosystem: string;
  package: string;
  installed: string;
  fixed: string | null;
  hosts: string[];
  binaries: string[];
  advisories: string[];
  cves: string[];
  kev: boolean;
  severity: Advisory['severity'];
  summary: string;
}

const RANK: Record<Advisory['severity'], number> = { CRITICAL: 4, HIGH: 3, MODERATE: 2, LOW: 1, unrated: 0 };

/** Folds matches into one finding per package, installed version and fix. */
export function buildFindings(matches: OsvMatch[], advisories: Map<string, Advisory>, kev: Set<string> | null): Finding[] {
  const out = new Map<string, Finding>();
  for (const m of matches) {
    for (const id of m.ids) {
      const adv = advisories.get(id);
      if (!adv) continue;
      const fixed = adv.fixed.get(`${m.query.ecosystem}|${m.query.name}`) ?? null;
      const key = `${m.query.ecosystem}|${m.query.name}|${m.query.version}|${fixed ?? 'nofix'}`;
      const f =
        out.get(key) ??
        ({
          key,
          ecosystem: m.query.ecosystem,
          package: m.query.name,
          installed: m.query.version,
          fixed,
          hosts: [...m.query.hosts].sort(),
          binaries: [...m.query.binaries].sort(),
          advisories: [],
          cves: [],
          kev: false,
          severity: 'unrated',
          summary: '',
        } satisfies Finding);
      f.advisories.push(id);
      for (const c of adv.cves) if (!f.cves.includes(c)) f.cves.push(c);
      if (kev && adv.cves.some((c) => kev.has(c))) f.kev = true;
      if (RANK[adv.severity] > RANK[f.severity]) f.severity = adv.severity;
      if (!f.summary && adv.summary) f.summary = adv.summary;
      out.set(key, f);
    }
  }
  return [...out.values()];
}

/** What deserves Pedro's eyes: exploited in the wild, or high severity with a fix to apply. */
export const isActionable = (f: Finding): boolean => f.kev || (f.fixed !== null && RANK[f.severity] >= RANK.HIGH);

export function sortFindings(fs: Finding[]): Finding[] {
  return [...fs].sort(
    (a, b) => Number(b.kev) - Number(a.kev) || RANK[b.severity] - RANK[a.severity] || b.hosts.length - a.hosts.length || a.package.localeCompare(b.package),
  );
}

export function upgradeHint(f: Finding): string {
  if (!f.fixed) return 'no fixed version published yet';
  if (f.ecosystem.startsWith('Debian')) return `\`apt-get install --only-upgrade ${f.binaries.slice(0, 3).join(' ') || f.package}\` (fixed in ${f.fixed})`;
  return `pin ${f.package} at ${f.fixed} or later in petedio-iac`;
}

export interface CveRun {
  snapshot: InventorySnapshot;
  hostsRead: number;
  hostsUnread: { name: string; error: string }[];
  queries: number;
  uniqueAdvisories: number;
  advisoriesFetched: number;
  advisoryGaps: string[];
  kevSize: number | null;
  kevError: string | null;
  truncated: number;
  imageCount: number;
  findings: Finding[];
  snapshotAgeHours: number;
}

export async function runCveCheck(snapshot: InventorySnapshot, now: Date, f: Fetch = fetch): Promise<CveRun> {
  if (snapshot.hosts.length === 0) throw new Error('the inventory snapshot lists no hosts, so nothing was examined');
  const readHosts = snapshot.hosts.filter((h) => h.ok);
  if (readHosts.length === 0) throw new Error('the collector read none of the hosts, so nothing was examined');
  const queries = buildQueries(snapshot);
  if (queries.length === 0) throw new Error('no host produced a package that OSV can match (unsupported OS ids?), so nothing was examined');
  const { matches, truncated } = await queryOsv(f, queries);
  const ids = [...new Set(matches.flatMap((m) => m.ids))];
  const { byId, failed, skipped } = await fetchAdvisories(f, ids);
  let kev: Set<string> | null = null;
  let kevError: string | null = null;
  try {
    kev = await fetchKev(f);
  } catch (err) {
    kevError = err instanceof Error ? err.message : String(err);
  }
  const advisoryGaps: string[] = [];
  if (failed.length) advisoryGaps.push(`${failed.length} advisories could not be fetched (${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ', …' : ''})`);
  if (skipped) advisoryGaps.push(`${skipped} advisories were not fetched because the daily cap is ${DETAIL_CAP}`);
  return {
    snapshot,
    hostsRead: readHosts.length,
    hostsUnread: snapshot.hosts.filter((h) => !h.ok).map((h) => ({ name: h.name, error: h.error ?? 'no reason recorded' })),
    queries: queries.length,
    uniqueAdvisories: ids.length,
    advisoriesFetched: byId.size,
    advisoryGaps,
    kevSize: kev?.size ?? null,
    kevError,
    truncated,
    imageCount: readHosts.reduce((n, h) => n + h.images.length, 0),
    findings: sortFindings(buildFindings(matches, byId, kev)),
    snapshotAgeHours: (now.getTime() - Date.parse(snapshot.generatedAt)) / 3_600_000,
  };
}

export function buildCveReport(run: CveRun, day: string, filed: string[] = [], fileGaps: string[] = []): string {
  const actionable = run.findings.filter(isActionable);
  const fixable = run.findings.filter((x) => x.fixed !== null && !isActionable(x));
  const gaps = [...run.advisoryGaps, ...fileGaps];
  for (const h of run.hostsUnread) gaps.push(`${h.name} was not scanned: ${clip(h.error, 100)}`);
  if (run.kevError) gaps.push(`${run.kevError}, so nothing is marked as exploited`);
  if (run.truncated) gaps.push(`${run.truncated} OSV answers were paged and only the first page was read`);
  if (run.snapshotAgeHours > STALE_SNAPSHOT_HOURS) gaps.push(`the inventory is ${Math.round(run.snapshotAgeHours)} hours old, so installed versions may have changed`);

  const lines = [
    `${gaps.length ? '⚠ INCOMPLETE ' : ''}**CVE check, ${day}**`,
    `Examined ${run.hostsRead} of ${run.snapshot.hosts.length} hosts, ${run.queries} package versions, ${run.uniqueAdvisories} advisories (${run.advisoriesFetched} read), ${run.kevSize ?? 'no'} CISA KEV entries. Inventory age ${Math.round(run.snapshotAgeHours)} h. ${run.imageCount} container images are listed but not matched (no image scanner).`,
    '',
    `**Act on (${actionable.length})**`,
  ];
  if (actionable.length === 0) lines.push(`- none of the ${run.findings.length} matched findings is exploited or high severity with a fix`);
  for (const x of actionable.slice(0, REPORT_CAP)) {
    const tag = [x.kev ? 'KEV' : null, x.severity !== 'unrated' ? x.severity : null].filter(Boolean).join(' ');
    lines.push(`- ${tag ? `**${tag}** ` : ''}\`${x.package}\` ${x.installed} on ${x.hosts.join(', ')}: ${x.cves.slice(0, 3).join(', ') || x.advisories[0]}${x.cves.length > 3 ? ` +${x.cves.length - 3}` : ''}. ${upgradeHint(x)}`);
  }
  if (actionable.length > REPORT_CAP) lines.push(`- … ${actionable.length - REPORT_CAP} more not shown`);
  lines.push('', `Fix available, lower severity or unrated: ${fixable.length}. No fix published: ${run.findings.length - actionable.length - fixable.length}.`);
  if (filed.length) lines.push('', `**Filed** ${filed.join(', ')}`);
  if (gaps.length) lines.push('', '**Not checked**', ...gaps.slice(0, 10).map((g) => `- ${g}`));
  return lines.join('\n');
}
