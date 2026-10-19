/**
 * The lab MCP (PET-667): the lab tools served to claude.ai project threads at
 * https://pdlab.dev/mcp/lab, through Cloudflare Access.
 *
 * Streamable HTTP, stateless: each POST carries one JSON-RPC request and gets one JSON
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
import { callTool, inputJsonSchema, type LabTool } from './tools/index.js';
import type { AccessResult } from './access.js';

export const MCP_PATH = '/mcp/lab';
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'petedio-lab', version: '1.0.0' };
const INSTRUCTIONS =
  "Read-only tools for Pedro's homelab. Live state (pve_guests, pve_guest, kuma_status, systemd_status, desk_status) " +
  'outranks the knowledge vault (find_host, host_note). Every result names what it read in `source`; a failed read is an error, never an empty result.';

export interface McpDeps {
  tools: Map<string, LabTool>;
  /** The only source address allowed, the cloudflared host. */
  allowedPeer: string;
  verify: (jwt: string | null) => Promise<AccessResult>;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

type Id = string | number | null;

const rpc = (id: Id, result: unknown) => json({ jsonrpc: '2.0', id, result });
const rpcError = (id: Id, code: number, message: string, status = 200) => json({ jsonrpc: '2.0', id, error: { code, message } }, status);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** IPv4 peers can arrive mapped into IPv6 (::ffff:192.168.50.112). */
export function normalizePeer(address: string | undefined): string {
  return (address ?? '').replace(/^::ffff:/, '');
}

export function createMcpHandler(deps: McpDeps): (req: Request, peer: string | undefined) => Promise<Response> {
  const log = deps.log ?? (() => {});
  const definitions = [...deps.tools.values()].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: inputJsonSchema(t.input),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }));

  return async (req, peer) => {
    const url = new URL(req.url);
    if (url.pathname !== MCP_PATH) return json({ error: 'not found' }, 404);

    const source = normalizePeer(peer);
    if (source !== deps.allowedPeer) {
      log('mcp refused', { reason: 'source not allowed', source });
      return json({ error: 'forbidden' }, 403);
    }
    const access = await deps.verify(req.headers.get('cf-access-jwt-assertion'));
    if (!access.ok) {
      log('mcp refused', { reason: access.reason, source });
      return json({ error: 'forbidden' }, 403);
    }

    if (req.method !== 'POST') return json({ error: 'use POST; this server keeps no stream' }, 405);
    // After initialize, the client names the version it negotiated. One we never offer is a
    // client this server does not speak to, so it gets 400 rather than a guess.
    const version = req.headers.get('mcp-protocol-version');
    if (version && !SUPPORTED_VERSIONS.includes(version)) return json({ error: `unsupported MCP-Protocol-Version ${version}` }, 400);

    let msg: { jsonrpc?: unknown; id?: Id; method?: unknown; params?: Record<string, unknown> };
    try {
      msg = (await req.json()) as typeof msg;
    } catch {
      return rpcError(null, -32700, 'parse error', 400);
    }
    if (Array.isArray(msg) || msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(null, -32600, 'invalid request: one JSON-RPC 2.0 object per POST', 400);
    }
    const id = msg.id ?? null;
    // A notification (no id) needs no answer.
    if (msg.id === undefined) return new Response(null, { status: 202 });

    switch (msg.method) {
      case 'initialize': {
        const asked = String(msg.params?.protocolVersion ?? '');
        return rpc(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return rpc(id, {});
      case 'tools/list':
        return rpc(id, { tools: definitions });
      case 'tools/call': {
        const name = String(msg.params?.name ?? '');
        const tool = deps.tools.get(name);
        if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
        const started = Date.now();
        const result = await callTool(tool, msg.params?.arguments ?? {});
        log('mcp call', {
          email: access.email,
          tool: name,
          input: msg.params?.arguments ?? {},
          ok: result.ok,
          bytes: result.ok ? Buffer.byteLength(result.text) : 0,
          ms: Date.now() - started,
          ...(result.ok ? {} : { error: result.error }),
        });
        return rpc(id, { content: [{ type: 'text', text: result.ok ? result.text : result.error }], isError: !result.ok });
      }
      default:
        return rpcError(id, -32601, `method not found: ${msg.method}`);
    }
  };
}
