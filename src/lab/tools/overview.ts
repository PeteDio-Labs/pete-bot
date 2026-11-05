/**
 * lab_overview: what is wrong in the lab right now, in one call (PET-860).
 *
 * It runs four existing tools (kuma_status, pve_guests, desk_status, systemd_status) in
 * parallel and folds their answers into one view. It reads nothing the four do not read.
 *
 * ⚠ EACH SECTION SUCCEEDS OR FAILS ON ITS OWN. A section that cannot read its source is
 * `{ ok: false, error }`, and `attention` names it. It is never left out and never reads as
 * "nothing wrong". `allSectionsRead` is false when any section failed. When EVERY section
 * fails the call throws, since a view built from nothing is a failed read.
 *
 * ⚠ `attention` IS A SHORT LIST, NOT A VERDICT. A stopped guest may be stopped on purpose.
 * The tool reports what it saw, with the count it covered, and the caller judges.
 */
import { z } from 'zod';
import { LabToolError, type LabTool } from './types.js';

/** A desk poll older than this is stalled. The poll runs every few minutes, so an hour is far past late. */
export const DESK_STALE_MS = 60 * 60 * 1000;

export const OVERVIEW_SOURCES = ['kuma_status', 'pve_guests', 'desk_status', 'systemd_status'] as const;

type Section = { ok: true; [k: string]: unknown } | { ok: false; error: string };

export function labOverviewTool(tools: Map<string, LabTool>, now: () => number = Date.now): LabTool {
  const input = z.object({});
  const call = async (name: string): Promise<{ source: string; data: Record<string, unknown> }> => {
    const tool = tools.get(name);
    if (!tool) throw new LabToolError(`${name} is not offered by this server`);
    return (await tool.run(tool.input.parse({}))) as { source: string; data: Record<string, unknown> };
  };
  /** A sibling that answers with another shape is a fault in the read, named here, not a TypeError. */
  const list = <T>(r: { data: Record<string, unknown> }, field: string): T[] => {
    const v = r.data[field];
    if (!Array.isArray(v)) throw new LabToolError(`the source answered with no "${field}" list`);
    return v as T[];
  };
  const guard = async (name: string, fold: (r: { source: string; data: Record<string, unknown> }) => Section): Promise<Section> => {
    try {
      return fold(await call(name));
    } catch (err) {
      return { ok: false, error: err instanceof LabToolError ? err.message : `internal error (${(err as Error)?.name ?? 'unknown'})` };
    }
  };

  return {
    name: 'lab_overview',
    description:
      'Start here to learn what is wrong in the lab right now. One call returns the monitors that are not up, the guests that ' +
      'are not running, the merge desk state and the unit state on 237, each read on its own. `attention` lists what to look at. ' +
      '`allSectionsRead` is false when a source could not be read, and then an empty `attention` does not mean healthy. ' +
      'Use kuma_status, pve_guests, desk_status or systemd_status for detail.',
    input,
    async run() {
      const [monitors, guests, desk, services] = await Promise.all([
        guard('kuma_status', (r) => {
          const all = list<{ name: string; status: string; since: string | null; message: string }>(r, 'monitors');
          return {
            ok: true,
            read: all.length,
            notUp: all.filter((m) => m.status !== 'up').map((m) => ({ name: m.name, status: m.status, since: m.since, message: m.message })),
          };
        }),
        guard('pve_guests', (r) => {
          const all = list<{ vmid: number; name: string; node: string; status: string }>(r, 'guests');
          const byNode: Record<string, number> = {};
          for (const g of all) byNode[g.node] = (byNode[g.node] ?? 0) + 1;
          return {
            ok: true,
            read: all.length,
            byNode,
            notRunning: all.filter((g) => g.status !== 'running').map((g) => ({ vmid: g.vmid, name: g.name, node: g.node, status: g.status })),
          };
        }),
        guard('desk_status', (r) => {
          const desk = r.data.desk as { mode?: unknown; lastPollAt?: string | null; lastPollError?: string | null };
          const at = desk.lastPollAt ?? null;
          const age = at ? now() - Date.parse(at) : null;
          // No poll yet, an unreadable time, or an old one: the desk may have stalled with no error.
          const stalled = age === null || Number.isNaN(age) || age > DESK_STALE_MS;
          return { ok: true, mode: desk.mode ?? null, lastPollAt: at, lastPollError: desk.lastPollError ?? null, stalled };
        }),
        guard('systemd_status', (r) => {
          const units = list<{ unit: string; active: string; sub: string; restarts: number | null; result: string }>(r, 'units');
          return {
            ok: true,
            read: units.length,
            notActive: units.filter((u) => u.active !== 'active' || (u.unit.endsWith('.service') && u.sub !== 'running')).map((u) => ({ unit: u.unit, active: u.active, sub: u.sub, restarts: u.restarts, result: u.result })),
          };
        }),
      ]);

      const sections = { monitors, guests, desk, services };
      const failed = Object.entries(sections).filter(([, s]) => !s.ok);
      if (failed.length === Object.keys(sections).length) {
        throw new LabToolError(`every source failed: ${failed.map(([k, s]) => `${k}: ${(s as { error: string }).error}`).join('; ')}`);
      }

      const attention: string[] = [];
      for (const [k, s] of failed) attention.push(`${k}: could not be read (${(s as { error: string }).error})`);
      if (monitors.ok) for (const m of monitors.notUp as Array<{ name: string; status: string }>) attention.push(`monitor ${m.name} is ${m.status}`);
      if (guests.ok) for (const g of guests.notRunning as Array<{ vmid: number; name: string; status: string }>) attention.push(`guest ${g.vmid} ${g.name} is ${g.status}`);
      if (desk.ok && desk.stalled) attention.push(`desk has not polled in the last hour (last poll ${String(desk.lastPollAt ?? 'never')})`);
      if (desk.ok && desk.lastPollError) attention.push(`desk poll error: ${String(desk.lastPollError).slice(0, 200)}`);
      if (services.ok) for (const u of services.notActive as Array<{ unit: string; active: string; sub: string }>) attention.push(`unit ${u.unit} is ${u.active}/${u.sub}`);

      const read = (s: Section, label: string) => (s.ok ? `${s.read} ${label}` : `${label} unread`);
      return {
        source: `${4 - failed.length} of 4 sections read: ${read(monitors, 'monitors')}, ${read(guests, 'guests')}, ${desk.ok ? 'desk' : 'desk unread'}, ${read(services, 'units')}; ${attention.length} to look at`,
        data: { allSectionsRead: failed.length === 0, attention, sections },
      };
    },
  };
}
