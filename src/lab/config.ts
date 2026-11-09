/**
 * lab-agent's settings (PET-669), checked once at startup.
 *
 * ⚠ A BAD SETTING STOPS lab-agent, AND ONLY lab-agent. This process has one job, and starting it with a
 * missing token or clone would answer every /lab with an error that looks like a lab fault,
 * so it refuses to start and systemd shows why.
 *
 * The deploy writes these to /etc/lab-agent/lab-agent.env, 0400 lab-agent (PET-670).
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseAgents } from './access.js';

/** 32 base64 characters carry 192 bits. Anything shorter was not minted by the seed script. */
const TOKEN = z.string().min(32, 'must be at least 32 characters').regex(/^\S+$/, 'must not contain whitespace');

const EnvSchema = z.object({
  LAB_PORT: z.coerce.number().int().min(1024).max(65535).default(3016),
  LAB_ASK_TOKEN: TOKEN,
  // The model backend (PET-742): a local Ollama lane. The Anthropic gateway is retired (PET-744),
  // so a stale LAB_PROVIDER=gateway is refused at startup instead of quietly running Ollama.
  LAB_PROVIDER: z.literal('ollama', { errorMap: () => ({ message: 'must be ollama; the Anthropic gateway was retired (PET-744)' }) }).default('ollama'),
  LAB_OLLAMA_URL: z.string().url().default('http://192.168.50.246:11434'),
  LAB_OLLAMA_NUM_CTX: z.coerce.number().int().min(2048).max(32768).default(8192),
  LAB_MODEL: z.string().min(1).optional(),
  LAB_PVE_URL: z.string().regex(/^https:\/\//, 'must be https://'),
  LAB_PVE_TOKEN_ID: z.string().regex(/^[^@\s]+@[^!\s]+![^\s=]+$/, 'must look like user@realm!name'),
  LAB_PVE_TOKEN_SECRET: z.string().min(8),
  LAB_PVE_CA_FILE: z.string().min(1).default('/etc/lab-agent/pve-root-ca.pem'),
  LAB_KUMA_URL: z.string().url().default('http://192.168.50.4:3001'),
  LAB_KUMA_SLUG: z.string().min(1).default('fault-study'),
  LAB_VAULT_CLONE: z.string().min(1),
  LAB_VAULT_ADDR: z.string().regex(/^https:\/\//, 'must be https://').default('https://192.168.50.223:8200'),
  LAB_VAULT_TOKEN: z.string().min(20),
  LAB_VAULT_CA_FILE: z.string().min(1).default('/etc/lab-agent/vault-ca.pem'),
  LAB_DESK_HEALTH_URL: z.string().url().default('http://127.0.0.1:3015/health'),
  // The nightly drift check (PET-671): pete-bot's /v1/notify and its bearer, and the time
  // of day in UTC. The bearer is pete-bot's notify token, which opens that route alone.
  LAB_NOTIFY_URL: z.string().url().default('http://127.0.0.1:3015/v1/notify'),
  LAB_NOTIFY_TOKEN: TOKEN,
  LAB_DRIFT_AT: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM in UTC').default('11:15'),
  // The MCP door (PET-667). Off until the Access app exists: LAB_ACCESS_AUD turns it on, and
  // then every MCP setting must be valid.
  LAB_MCP_HOST: z.string().ip({ version: 'v4' }).optional(),
  LAB_MCP_PORT: z.coerce.number().int().min(1024).max(65535).default(3017),
  LAB_MCP_PEER: z.string().ip({ version: 'v4' }).default('192.168.50.112'),
  LAB_ACCESS_TEAM_DOMAIN: z.string().regex(/^[a-z0-9-]+\.cloudflareaccess\.com$/, 'must look like <team>.cloudflareaccess.com').optional(),
  LAB_ACCESS_AUD: z.string().regex(/^[0-9a-f]{64}$/, 'must be the 64-hex AUD tag').optional(),
  LAB_ACCESS_EMAILS: z.string().optional(),
  // Agent service tokens for the lab MCP, `<client id>=<name>,...` (PET-904).
  LAB_ACCESS_AGENTS: z.string().optional(),
  // plane_item (PET-672). The tool is offered only when the token is set, so a deploy that
  // runs before the seed still starts.
  LAB_PLANE_URL: z.string().url().default('http://192.168.50.235:8080'),
  LAB_PLANE_WORKSPACE: z.string().min(1).default('petedio'),
  // Project identifiers plane_item may read (PET-859). GOOF stays out: it is personal.
  LAB_PLANE_PROJECTS: z.string().regex(/^[A-Z][A-Z0-9]{1,9}(,[A-Z][A-Z0-9]{1,9})*$/, 'must be identifiers such as PET,FOL').default('PET,FOL'),
  LAB_PLANE_TOKEN: TOKEN.optional(),
  // search_lab (PET-745). The tool is offered only when the token is set.
  LAB_SEARCH_URL: z.string().url().default('http://192.168.50.12:8526'),
  LAB_SEARCH_TOKEN: TOKEN.optional(),
  // mtrace, for the media assistant (PET-869). 237 reaches its own LAN address through the
  // `lo` allowlist rule. The tools are offered only when the token is set, and the token is
  // lab-agent's own caller (`token_lab-agent`), never pete-bot's.
  LAB_MTRACE_URL: z.string().url().default('http://192.168.50.237:8237'),
  LAB_MTRACE_TOKEN: TOKEN.optional(),
  // Bazarr, for the subtitle search the owner confirms (PET-869). Offered only when the key is set.
  LAB_BAZARR_URL: z.string().url().default('http://192.168.50.222:6767'),
  LAB_BAZARR_KEY: z.string().min(16, 'must be at least 16 characters').regex(/^\S+$/, 'must not contain whitespace').optional(),
  LAB_IAC_CLONE: z.string().min(1),
  LAB_MEDIA_IAC_CLONE: z.string().min(1),
  // The vault is private and deploy keys are disabled org-wide, so its fetch carries a
  // read token from the petedio-workspace-mirror App (PET-670, PET-542).
  LAB_GITHUB_APP_ID: z.string().regex(/^\d+$/, 'must be a number'),
  LAB_GITHUB_APP_INSTALLATION_ID: z.string().regex(/^\d+$/, 'must be a number'),
  LAB_GITHUB_APP_KEY_FILE: z.string().min(1).default('/etc/lab-agent/github-app.pem'),
  LAB_VAULT_REPO: z.string().regex(/^[\w.-]+$/, 'must be a bare repository name').default('petedio-vault'),
});

export interface LabConfig {
  port: number;
  askToken: string;
  model: string;
  ollama: { url: string; numCtx: number };
  proxmox: { baseUrl: string; tokenId: string; tokenSecret: string; caPem: string };
  kuma: { baseUrl: string; slug: string };
  clones: { vault: string; iac: string; mediaIac: string };
  github: { appId: string; installationId: string; privateKeyPem: string; vaultRepo: string };
  vault: { addr: string; token: string; caPem: string };
  deskHealthUrl: string;
  /** null while no Plane token is set. */
  plane: { baseUrl: string; workspace: string; identifiers: string[]; token: string } | null;
  /** null while no search token is set. */
  search: { baseUrl: string; token: string } | null;
  /** null while no mtrace token is set: the media assistant then answers 404. */
  mtrace: { baseUrl: string; token: string } | null;
  /** null while no Bazarr key is set: no subtitle tools, no subtitle action. */
  bazarr: { baseUrl: string; apiKey: string } | null;
  drift: { notifyUrl: string; notifyToken: string; at: string };
  /** null while the MCP door is off. */
  mcp: { host: string; port: number; peer: string; teamDomain: string; aud: string; emails: string[]; agents: Record<string, string> } | null;
}

export function loadLabConfig(env: Record<string, string | undefined>, readFile = (p: string) => readFileSync(p, 'utf8')): LabConfig {
  // An empty variable means unset, so a template that renders "" still hits the default or the error.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([k, v]) => k.startsWith('LAB_') && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    // Names and rules only, never values: a token can be one of the failing fields.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`lab-agent settings are invalid: ${issues}`);
  }
  const e = parsed.data;
  if (e.LAB_NOTIFY_TOKEN === e.LAB_ASK_TOKEN) {
    throw new Error('lab-agent settings are invalid: LAB_NOTIFY_TOKEN must differ from LAB_ASK_TOKEN');
  }
  const read = (name: string, path: string) => {
    try {
      return readFile(path);
    } catch (err) {
      throw new Error(`lab-agent cannot read ${name} ${path}: ${(err as Error).message}`);
    }
  };
  const caPem = read('LAB_PVE_CA_FILE', e.LAB_PVE_CA_FILE);
  const vaultCa = read('LAB_VAULT_CA_FILE', e.LAB_VAULT_CA_FILE);

  let mcp: LabConfig['mcp'] = null;
  if (e.LAB_ACCESS_AUD) {
    const emails = (e.LAB_ACCESS_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    let agents: Record<string, string>;
    try {
      agents = parseAgents(e.LAB_ACCESS_AGENTS);
    } catch (err) {
      throw new Error(`lab-agent settings are invalid: LAB_ACCESS_AGENTS: ${(err as Error).message}`);
    }
    const missing = [
      !e.LAB_MCP_HOST && 'LAB_MCP_HOST',
      !e.LAB_ACCESS_TEAM_DOMAIN && 'LAB_ACCESS_TEAM_DOMAIN',
      emails.length === 0 && Object.keys(agents).length === 0 && 'LAB_ACCESS_EMAILS',
    ].filter(Boolean);
    if (missing.length) throw new Error(`lab-agent settings are invalid: LAB_ACCESS_AUD is set, so ${missing.join(', ')} must be too`);
    if (e.LAB_MCP_PORT === e.LAB_PORT) throw new Error('lab-agent settings are invalid: LAB_MCP_PORT must differ from LAB_PORT');
    mcp = { host: e.LAB_MCP_HOST!, port: e.LAB_MCP_PORT, peer: e.LAB_MCP_PEER, teamDomain: e.LAB_ACCESS_TEAM_DOMAIN!, aud: e.LAB_ACCESS_AUD, emails, agents };
  }
  let privateKeyPem: string;
  try {
    privateKeyPem = readFile(e.LAB_GITHUB_APP_KEY_FILE);
  } catch (err) {
    throw new Error(`lab-agent cannot read LAB_GITHUB_APP_KEY_FILE ${e.LAB_GITHUB_APP_KEY_FILE}: ${(err as Error).message}`);
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKeyPem)) {
    throw new Error(`lab-agent settings are invalid: LAB_GITHUB_APP_KEY_FILE ${e.LAB_GITHUB_APP_KEY_FILE} holds no PEM private key`);
  }
  return {
    port: e.LAB_PORT,
    askToken: e.LAB_ASK_TOKEN,
    model: e.LAB_MODEL ?? 'qwen3:8b',
    ollama: { url: e.LAB_OLLAMA_URL.replace(/\/$/, ''), numCtx: e.LAB_OLLAMA_NUM_CTX },
    proxmox: { baseUrl: e.LAB_PVE_URL, tokenId: e.LAB_PVE_TOKEN_ID, tokenSecret: e.LAB_PVE_TOKEN_SECRET, caPem },
    kuma: { baseUrl: e.LAB_KUMA_URL, slug: e.LAB_KUMA_SLUG },
    clones: { vault: e.LAB_VAULT_CLONE, iac: e.LAB_IAC_CLONE, mediaIac: e.LAB_MEDIA_IAC_CLONE },
    github: {
      appId: e.LAB_GITHUB_APP_ID,
      installationId: e.LAB_GITHUB_APP_INSTALLATION_ID,
      privateKeyPem,
      vaultRepo: e.LAB_VAULT_REPO,
    },
    vault: { addr: e.LAB_VAULT_ADDR, token: e.LAB_VAULT_TOKEN, caPem: vaultCa },
    deskHealthUrl: e.LAB_DESK_HEALTH_URL,
    plane: e.LAB_PLANE_TOKEN
      ? { baseUrl: e.LAB_PLANE_URL, workspace: e.LAB_PLANE_WORKSPACE, identifiers: e.LAB_PLANE_PROJECTS.split(','), token: e.LAB_PLANE_TOKEN }
      : null,
    search: e.LAB_SEARCH_TOKEN ? { baseUrl: e.LAB_SEARCH_URL.replace(/\/$/, ''), token: e.LAB_SEARCH_TOKEN } : null,
    mtrace: e.LAB_MTRACE_TOKEN ? { baseUrl: e.LAB_MTRACE_URL.replace(/\/$/, ''), token: e.LAB_MTRACE_TOKEN } : null,
    bazarr: e.LAB_BAZARR_KEY ? { baseUrl: e.LAB_BAZARR_URL.replace(/\/$/, ''), apiKey: e.LAB_BAZARR_KEY } : null,
    drift: { notifyUrl: e.LAB_NOTIFY_URL, notifyToken: e.LAB_NOTIFY_TOKEN, at: e.LAB_DRIFT_AT },
    mcp,
  };
}
