/**
 * desk_status and systemd_status: what is running on 237 itself (PET-667).
 *
 * Both read only this host. desk_status asks pete-bot's public /health, which carries the
 * merge desk's mode and its last poll; systemd_status runs `systemctl show` for a fixed list
 * of units. Neither takes a free-form name: the unit is chosen from a list, so a caller can't
 * read an arbitrary unit or pass an option to systemctl.
 */
import { z } from 'zod';
import { fetchWithTimeout, LabToolError, type LabTool } from './types.js';

export interface DeskConfig {
  /** pete-bot's health URL, such as http://127.0.0.1:3015/health */
  healthUrl: string;
  fetch?: typeof fetch;
}

export function deskStatusTool(cfg: DeskConfig): LabTool {
  const input = z.object({});
  return {
    name: 'desk_status',
    description:
      "The merge desk's state from pete-bot's /health: its mode, the repos it watches, when it last polled, how many " +
      'PRs that poll read, any poll error, and how many PRs it has merged.',
    input,
    async run() {
      const res = await fetchWithTimeout(cfg.fetch ?? fetch, cfg.healthUrl, { method: 'GET' }, 5_000, 'pete-bot /health');
      if (!res.ok) throw new LabToolError(`pete-bot /health answered HTTP ${res.status}`);
      let body: { desk?: unknown; uptimeSeconds?: unknown };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new LabToolError('pete-bot /health answered with a body that is not JSON');
      }
      if (!body?.desk) throw new LabToolError('pete-bot /health carries no desk field');
      return {
        source: `pete-bot /health at ${cfg.healthUrl}`,
        data: { desk: body.desk, peteBotUptimeSec: body.uptimeSeconds ?? null },
      };
    },
  };
}

export type SystemctlRunner = (args: string[]) => Promise<string>;

export const runSystemctl: SystemctlRunner = async (args) => {
  const proc = Bun.spawn(['systemctl', ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LC_ALL: 'C' } });
  const timer = setTimeout(() => proc.kill(), 10_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`systemctl exited ${code}: ${stderr.trim().split('\n').pop() ?? ''}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
};

const PROPERTIES = ['Id', 'LoadState', 'ActiveState', 'SubState', 'ActiveEnterTimestamp', 'NRestarts', 'Result'];

export function parseShow(out: string): Array<Record<string, string>> {
  // `systemctl show a b` separates units with a blank line.
  return out
    .trim()
    .split(/\n\s*\n/)
    .map((block) => Object.fromEntries(block.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])));
}

export function systemdStatusTool(units: readonly string[], run: SystemctlRunner = runSystemctl): LabTool {
  if (units.length === 0) throw new Error('systemd_status needs at least one unit');
  for (const u of units) if (!/^[\w@.-]+\.(service|timer)$/.test(u)) throw new Error(`systemd_status: bad unit name ${u}`);
  const input = z.object({
    unit: z.enum(units as [string, ...string[]]).optional().describe('One unit; omit for all of them'),
  });
  return {
    name: 'systemd_status',
    description: `State of the systemd units on 237 (${units.join(', ')}): active or not, since when, restart count and last result.`,
    input,
    async run({ unit }: z.infer<typeof input>) {
      const wanted = unit ? [unit] : [...units];
      let out: string;
      try {
        out = await run(['show', `--property=${PROPERTIES.join(',')}`, '--', ...wanted]);
      } catch (err) {
        throw new LabToolError(`systemctl show failed: ${(err as Error).message}`);
      }
      // Blank output parses to one empty block. That is no data, so it must not read as a unit.
      if (!out.trim()) throw new LabToolError('systemctl show returned no output');
      const shown = parseShow(out);
      if (shown.length !== wanted.length) throw new LabToolError(`systemctl showed ${shown.length} units for ${wanted.length} asked`);
      const ids = shown.map((x) => x.Id);
      if (wanted.some((w, i) => ids[i] !== w)) throw new LabToolError(`systemctl showed ${JSON.stringify(ids)} for ${JSON.stringify(wanted)}`);
      return {
        source: `systemctl show for ${wanted.length} unit${wanted.length === 1 ? '' : 's'} on this host`,
        data: {
          units: shown.map((s) => ({
            unit: s.Id ?? '',
            loaded: s.LoadState ?? '',
            active: s.ActiveState ?? '',
            sub: s.SubState ?? '',
            since: s.ActiveEnterTimestamp || null,
            restarts: s.NRestarts === undefined ? null : Number(s.NRestarts),
            result: s.Result ?? '',
          })),
        },
      };
    },
  };
}
