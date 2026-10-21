/**
 * lab-agent: the lab-map agent's own process (PET-669). It runs as the `lab-agent` Unix
 * user under its own systemd unit on 237, never inside pete-bot.
 *
 * ⚠ WHY A SECOND PROCESS. pete-bot holds the Discord token and the merge desk's App key,
 * which can merge. This process holds the read credentials and runs the model loop, and it
 * holds nothing that can merge, deploy or write. pete-bot's /lab command reaches it over
 * 127.0.0.1 with the ask bearer and gives it none of its own credentials.
 *
 * Built as its own binary: `bun run build:lab-binary`.
 */
import { gatewayCaller } from './agent.js';
import { loadLabConfig, type LabConfig } from './config.js';
import { AccessVerifier } from './access.js';
import { createMcpHandler } from './mcp.js';
import { createLabHandler, type Check } from './server.js';
import { buildLabTools, GitClone, LAB_UNITS, secretsHealth, VaultMetadataClient } from './tools/index.js';
import { ProxmoxClient } from './tools/proxmox.js';
import { readKuma } from './tools/kuma.js';

function log(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...fields }));
}

// One line naming the bad setting, then exit, so systemd's status shows why it stopped.
let cfg: LabConfig;
try {
  cfg = loadLabConfig(process.env);
} catch (err) {
  log('lab-agent refused to start', { error: (err as Error).message });
  process.exit(1);
}

const vault = new GitClone('petedio-vault', cfg.clones.vault);
const history = [new GitClone('petedio-iac', cfg.clones.iac), new GitClone('petedio-media-iac', cfg.clones.mediaIac)];
const tools = buildLabTools({
  vault,
  history,
  proxmox: cfg.proxmox,
  kuma: cfg.kuma,
  secrets: cfg.vault,
  deskHealthUrl: cfg.deskHealthUrl,
  units: LAB_UNITS,
});
const pve = new ProxmoxClient(cfg.proxmox);
const secrets = new VaultMetadataClient(cfg.vault);

// Keep the periodic Vault token alive. A failure is logged and shows on /health; it is not
// fatal, because Vault seals nightly and a sealed Vault refuses renewals until it opens.
let lastRenewError: string | null = null;
async function renew(): Promise<void> {
  try {
    await secrets.renewSelf();
    lastRenewError = null;
  } catch (err) {
    lastRenewError = (err as Error).message;
    log('vault token renewal failed', { error: lastRenewError });
  }
}
void renew();
setInterval(() => void renew(), 12 * 60 * 60_000);

const checks: Record<string, Check> = {
  async gateway() {
    // An empty body proves the bearer and spends nothing: the gateway checks the bearer
    // first (401), then refuses the body (400) before it forwards anything. It cannot prove
    // the model grant or the monthly cap; only a forwarded request can, and that spends.
    const res = await fetch(`${cfg.gateway.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.gateway.token}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 400) return 'bearer accepted';
    if (res.status === 401) throw new Error('gateway refused the lab-map bearer (HTTP 401)');
    throw new Error(`gateway answered HTTP ${res.status} to an empty probe; expected 400`);
  },
  async proxmox() {
    return `${(await pve.guests()).length} guests`;
  },
  async vault() {
    await vault.refresh();
    const s = await vault.state();
    if (s.fetchError) throw new Error(`fetch failed: ${s.fetchError}`);
    return GitClone.describe('petedio-vault', s);
  },
  async kuma() {
    return `${(await readKuma(cfg.kuma)).length} monitors`;
  },
  async secrets() {
    return secretsHealth(secrets, lastRenewError, async () => {
      await renew();
      return lastRenewError;
    });
  },
};

const handler = createLabHandler({
  askToken: cfg.askToken,
  tools,
  callModel: gatewayCaller(cfg.gateway.url, cfg.gateway.token),
  model: cfg.gateway.model,
  checks,
  log,
});

const server = Bun.serve({ hostname: '127.0.0.1', port: cfg.port, fetch: handler });
log('lab-agent listening', { address: `127.0.0.1:${server.port}`, tools: [...tools.keys()], model: cfg.gateway.model });

// The MCP door (PET-667): on the LAN address, for the tunnel host only, behind Access.
if (cfg.mcp) {
  const mcpCfg = cfg.mcp;
  const access = new AccessVerifier({ teamDomain: mcpCfg.teamDomain, aud: mcpCfg.aud, emails: mcpCfg.emails });
  const mcpHandler = createMcpHandler({ tools, allowedPeer: mcpCfg.peer, verify: (jwt) => access.verify(jwt), log });
  const mcpServer = Bun.serve({
    hostname: mcpCfg.host,
    port: mcpCfg.port,
    fetch: (req, srv) => mcpHandler(req, srv.requestIP(req)?.address),
  });
  log('lab MCP listening', { address: `${mcpCfg.host}:${mcpServer.port}`, peer: mcpCfg.peer, tools: [...tools.keys()] });
} else {
  log('lab MCP off: LAB_ACCESS_AUD is not set');
}
