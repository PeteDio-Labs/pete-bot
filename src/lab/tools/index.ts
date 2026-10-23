/**
 * The lab tool library (PET-668): one registry of read-only tools that both front doors use.
 * The lab-map agent's /lab loop (PET-669) and the lab MCP at pdlab.dev/mcp/lab (PET-667)
 * each build it once from their settings and call tools through callTool.
 *
 * It ships unused: nothing in the pete-bot process imports it.
 */
import { GitClone } from './git.js';
import { findHostTool, HostIndex, hostNoteTool } from './hosts.js';
import { gitHistoryTool } from './history.js';
import { kumaStatusTool, type KumaConfig } from './kuma.js';
import { deskStatusTool, systemdStatusTool, type SystemctlRunner } from './local.js';
import { VaultMetadataClient, vaultPresenceTool, type VaultConfig } from './vault.js';
import { PlaneClient, planeItemTool, type PlaneConfig } from './plane.js';
import { ProxmoxClient, pveGuestsTool, pveGuestTool, type ProxmoxConfig } from './proxmox.js';
import { inputJsonSchema, type LabTool } from './types.js';

export { callTool, capText, inputJsonSchema, LabToolError, type LabTool, type ToolResult } from './types.js';
export { GitClone, runGit, type GitRunner } from './git.js';
export { secretsHealth, VaultMetadataClient } from './vault.js';

/** The units systemd_status reads on 237: the two processes this repo builds. */
export const LAB_UNITS = ['pete-bot.service', 'lab-agent.service'] as const;

export interface LabToolsConfig {
  /** A read-only clone of petedio-vault. */
  vault: GitClone;
  /** Clones of the public iac repos, named as callers will ask for them. */
  history: GitClone[];
  proxmox: ProxmoxConfig;
  kuma: KumaConfig;
  /** HashiCorp Vault, for vault_presence. `vault` above is the knowledge-vault clone. */
  secrets: VaultConfig;
  deskHealthUrl: string;
  /** Plane, for plane_item (PET-672). Absent until the token is seeded, and then the tool is not offered. */
  plane?: PlaneConfig;
  /** The systemd units on this host that systemd_status may read. */
  units: readonly string[];
  systemctl?: SystemctlRunner;
}

export function buildLabTools(cfg: LabToolsConfig): Map<string, LabTool> {
  const hosts = new HostIndex(cfg.vault);
  const pve = new ProxmoxClient(cfg.proxmox);
  const tools = [
    findHostTool(hosts),
    hostNoteTool(hosts),
    pveGuestsTool(pve),
    pveGuestTool(pve),
    kumaStatusTool(cfg.kuma),
    gitHistoryTool(cfg.history),
    deskStatusTool({ healthUrl: cfg.deskHealthUrl }),
    systemdStatusTool(cfg.units, cfg.systemctl),
    vaultPresenceTool(new VaultMetadataClient(cfg.secrets)),
    ...(cfg.plane ? [planeItemTool(new PlaneClient(cfg.plane))] : []),
  ];
  return new Map(tools.map((t) => [t.name, t]));
}

/** The tool list in the shape both the Anthropic `tools` array and MCP `tools/list` take. */
export function toolDefinitions(tools: Map<string, LabTool>): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return [...tools.values()].map((t) => ({ name: t.name, description: t.description, input_schema: inputJsonSchema(t.input) }));
}
