/**
 * createMcpHandler: the one JSON-RPC handler every PeteDio MCP server uses.
 *
 * Streamable HTTP, stateless: each POST carries one JSON-RPC request and gets one JSON
 * answer. No session id, no event stream. The methods are `initialize`, `ping`, `tools/list`
 * and `tools/call`; a notification gets 202 and no body.
 *
 * It follows the lab MCP's handler (pete-bot `src/lab/mcp.ts`) and adds three rules:
 *
 * - TIERS. `exposeTiers` (default `['read']`) names the tiers this server lists and runs. A
 *   tool in another tier is an unknown tool. `readOnlyHint` comes from the tier, never from
 *   a hand-typed value.
 * - REDACTION. Every result and every error passes through `redact` before it leaves.
 * - NO INPUT TEXT IN LOGS. A call logs the tool, the caller, the input's length, the outcome
 *   and the result size. A title or a query can be private.
 *
 * EVERY REQUEST IS CHECKED TWICE: its source must be the tunnel's address, and its Access
 * JWT must verify. A request that fails either gets 403 and runs nothing.
 */
import { callTool, inputJsonSchema, type McpTool, type Tier } from './tool.js';
import { redact } from './redact.js';
import type { AccessResult } from './access.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

export interface McpDeps {
  /** Sent in `initialize`, such as { name: 'petedio-lab', version: '1.0.0' }. */
  serverInfo: { name: string; version: string };
  instructions: string;
  /** The only path served, such as /mcp/lab. */
  path: string;
  tools: Map<string, McpTool>;
  /** Tiers this server lists and runs. Default ['read']. */
  exposeTiers?: readonly Tier[];
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
  const tiers = deps.exposeTiers ?? ['read'];
  const served = new Map([...deps.tools].filter(([, t]) => tiers.includes(t.tier)));
  const definitions = [...served.values()].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: inputJsonSchema(t.input),
    annotations: { readOnlyHint: t.tier === 'read', destructiveHint: false, openWorldHint: false },
  }));

  return async (req, peer) => {
    const url = new URL(req.url);
    if (url.pathname !== deps.path) return json({ error: 'not found' }, 404);

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
    if (msg.id === undefined) return new Response(null, { status: 202 });

    switch (msg.method) {
      case 'initialize': {
        const asked = String(msg.params?.protocolVersion ?? '');
        return rpc(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: deps.serverInfo,
          instructions: deps.instructions,
        });
      }
      case 'ping':
        return rpc(id, {});
      case 'tools/list':
        return rpc(id, { tools: definitions });
      case 'tools/call': {
        const name = String(msg.params?.name ?? '');
        const args = msg.params?.arguments ?? {};
        const inputLength = JSON.stringify(args).length;
        const tool = served.get(name);
        if (!tool) {
          log('mcp call', { caller: access.email, tool: name, inputLength, ok: false, rejected: 'unknown tool' });
          return rpcError(id, -32602, `unknown tool: ${name}`);
        }
        const started = Date.now();
        const result = await callTool(tool, args);
        const body = redact(result.ok ? result.text : result.error);
        log('mcp call', {
          caller: access.email,
          tool: name,
          tier: tool.tier,
          inputLength,
          ok: result.ok,
          bytes: Buffer.byteLength(body.text),
          redacted: body.changed,
          ms: Date.now() - started,
          ...(result.ok ? {} : { error: body.text }),
        });
        return rpc(id, { content: [{ type: 'text', text: body.text }], isError: !result.ok });
      }
      default:
        return rpcError(id, -32601, `method not found: ${msg.method}`);
    }
  };
}
