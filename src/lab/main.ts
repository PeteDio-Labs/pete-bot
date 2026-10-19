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
import { createLabHandler, type Check } from './server.js';
import { buildLabTools, GitClone } from './tools/index.js';
import { ProxmoxClient } from './tools/proxmox.js';
import { readKuma } from './tools/kuma.js';
import { gitAuthFromToken, repoReadToken } from './tools/githubToken.js';

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

const vault = new GitClone('petedio-vault', cfg.clones.vault).useAuth(
  gitAuthFromToken(repoReadToken({ ...cfg.github, repo: cfg.github.vaultRepo })),
);
const history = [new GitClone('petedio-iac', cfg.clones.iac), new GitClone('petedio-media-iac', cfg.clones.mediaIac)];
const tools = buildLabTools({ vault, history, proxmox: cfg.proxmox, kuma: cfg.kuma });
const pve = new ProxmoxClient(cfg.proxmox);

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
