/**
 * kuma_status: what Uptime Kuma sees right now (PET-668).
 *
 * Reads the public status-page JSON on Pete-Pi (`http://192.168.50.4:3001`), which needs no
 * credential: `/api/status-page/<slug>` lists the monitors and
 * `/api/status-page/heartbeat/<slug>` holds the last beats and 24-hour uptime of each.
 *
 * ⚠ IT SEES ONLY THE MONITORS ON THAT STATUS PAGE. The `source` line says how many it read,
 * so a page missing a monitor shows up as a low count, not as "all up". A page with no
 * monitors at all is an error.
 */
import { z } from 'zod';
import { fetchWithTimeout, LabToolError, type LabTool } from './types.js';

export interface KumaConfig {
  baseUrl: string;
  slug: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Kuma's heartbeat status codes. */
const STATUS: Record<number, string> = { 0: 'down', 1: 'up', 2: 'pending', 3: 'maintenance' };

interface Beat {
  status: number;
  time: string;
  msg?: string;
  ping?: number | null;
}

export interface MonitorState {
  id: number;
  name: string;
  group: string;
  status: string;
  /** When the current status began, from the beats Kuma returned (about the last 30 minutes). */
  since: string | null;
  lastBeat: string | null;
  message: string;
  pingMs: number | null;
  uptime24h: number | null;
}

async function getJson(cfg: KumaConfig, path: string): Promise<unknown> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}${path}`;
  const res = await fetchWithTimeout(cfg.fetch ?? fetch, url, { method: 'GET' }, cfg.timeoutMs ?? 8_000, `Uptime Kuma ${path}`);
  if (!res.ok) throw new LabToolError(`Uptime Kuma ${path} answered HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new LabToolError(`Uptime Kuma ${path} answered with a body that is not JSON`);
  }
}

export async function readKuma(cfg: KumaConfig): Promise<MonitorState[]> {
  const slug = encodeURIComponent(cfg.slug);
  const [page, beats] = (await Promise.all([
    getJson(cfg, `/api/status-page/${slug}`),
    getJson(cfg, `/api/status-page/heartbeat/${slug}`),
  ])) as [
    { publicGroupList?: Array<{ name?: string; monitorList?: Array<{ id: number; name: string }> }> },
    { heartbeatList?: Record<string, Beat[]>; uptimeList?: Record<string, number> },
  ];

  const monitors = (page.publicGroupList ?? []).flatMap((g) =>
    (g.monitorList ?? []).map((m) => ({ id: m.id, name: m.name, group: g.name ?? '' })),
  );
  if (monitors.length === 0) throw new LabToolError(`Uptime Kuma status page "${cfg.slug}" lists 0 monitors`);

  return monitors.map((m) => {
    const list = [...(beats.heartbeatList?.[String(m.id)] ?? [])].sort((a, b) => a.time.localeCompare(b.time));
    const last = list.at(-1);
    let since: string | null = null;
    if (last) {
      since = last.time;
      for (let i = list.length - 1; i >= 0 && list[i]!.status === last.status; i--) since = list[i]!.time;
    }
    const uptime = beats.uptimeList?.[`${m.id}_24`];
    return {
      ...m,
      status: last ? (STATUS[last.status] ?? `status ${last.status}`) : 'no beats',
      since,
      lastBeat: last?.time ?? null,
      message: (last?.msg ?? '').slice(0, 200),
      pingMs: last?.ping ?? null,
      uptime24h: typeof uptime === 'number' ? Math.round(uptime * 10_000) / 100 : null,
    };
  });
}

export function kumaStatusTool(cfg: KumaConfig): LabTool {
  const input = z.object({
    only: z.enum(['all', 'not_up']).default('all').describe('"not_up" returns only monitors that are down, pending, in maintenance or silent'),
    name: z.string().max(64).optional().describe('Only monitors whose name contains this text, case-insensitive'),
  });
  return {
    name: 'kuma_status',
    description:
      "Uptime Kuma's view of the lab right now: each monitor's status, since when, its last message, ping " +
      'and 24-hour uptime percentage.',
    input,
    async run({ only, name }: z.infer<typeof input>) {
      const all = await readKuma(cfg);
      const notUp = all.filter((m) => m.status !== 'up');
      const monitors = all.filter(
        (m) => (only === 'all' || m.status !== 'up') && (!name || m.name.toLowerCase().includes(name.toLowerCase())),
      );
      return {
        source: `${all.length} monitors from Uptime Kuma status page "${cfg.slug}", ${notUp.length} not up`,
        data: { monitors },
      };
    },
  };
}
