/**
 * The lab MCP (PET-667): the lab tools served to claude.ai project threads at
 * https://pdlab.dev/mcp/lab, through Cloudflare Access.
 *
 * The handler itself is the shared one in src/mcp-kit; this file supplies the lab's name,
 * instructions, path and tools. Streamable HTTP, stateless: each POST carries one JSON-RPC request and gets one JSON
 * answer. No session id, no server-sent events, no GET stream, because every tool is one
 * read that answers at once. The methods are `initialize`, `ping`, `tools/list` and
 * `tools/call`; a notification gets 202 and no body.
 *
 * ⚠ NO `ask` TOOL. A thread is already a model. An `ask` tool would run a Haiku loop on the
 * lab-map cap for a question the thread can answer with the raw tools on the Max quota.
 *
 * ⚠ EVERY REQUEST IS CHECKED TWICE: its source must be the tunnel's address, and its Access
 * JWT must verify (access.ts). A request that fails either gets 403 and runs nothing. Every
 * call is logged with the caller's email, the tool, its input, its outcome and its size,
 * because the connector acts on Pedro's grant and this log is the only per-call record.
 */
import { createMcpHandler as createKitHandler, normalizePeer, type McpDeps as KitDeps } from '../mcp-kit/index.js';
import { toMcpTool, type LabTool } from './tools/types.js';
import type { AccessResult } from './access.js';

export { normalizePeer };
export const MCP_PATH = '/mcp/lab';
const SERVER_INFO = { name: 'petedio-lab', version: '1.0.0' };
const INSTRUCTIONS =
  "Tools for Pedro's homelab. All are reads except queue_codex_review, which starts a second-opinion Codex review. For \"what is wrong right now\", call lab_overview first. Live state (pve_guests, pve_guest, kuma_status, systemd_status, desk_status) " +
  'outranks the knowledge vault (find_host, host_note). Every result names what it read in `source`; a failed read is an error, never an empty result.';

export interface McpDeps {
  tools: Map<string, LabTool>;
  /** The only source address allowed, the cloudflared host. */
  allowedPeer: string;
  verify: (jwt: string | null) => Promise<AccessResult>;
  log?: KitDeps['log'];
}

export function createMcpHandler(deps: McpDeps): (req: Request, peer: string | undefined) => Promise<Response> {
  return createKitHandler({
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    path: MCP_PATH,
    tools: new Map([...deps.tools].map(([name, tool]) => [name, toMcpTool(tool)])),
    // The lab serves queue_codex_review, a write, so it exposes both tiers.
    exposeTiers: ['read', 'write'],
    allowedPeer: deps.allowedPeer,
    verify: deps.verify,
    log: deps.log,
  });
}
